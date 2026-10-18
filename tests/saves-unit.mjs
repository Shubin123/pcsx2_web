// SPDX-License-Identifier: GPL-3.0+
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createSuperblock, parsePSV } from '../web/saves.js';

test('createSuperblock returns valid 8192-byte PS2 memory card superblock', () => {
  const sb = createSuperblock();
  assert.equal(sb instanceof Uint8Array, true);
  assert.equal(sb.length, 8192);

  const text = new TextDecoder('ascii').decode(sb.subarray(0, 27));
  assert.equal(text, 'Sony PS2 Memory Card Format');
  assert.equal(sb[0x16], 0x6f); // 'o' checked by FolderMemoryCard::IsFormatted()

  const view = new DataView(sb.buffer, sb.byteOffset, sb.byteLength);
  assert.equal(view.getUint16(0x28, true), 512);   // page_len
  assert.equal(view.getUint16(0x2a, true), 2);     // pages_per_cluster
  assert.equal(view.getUint16(0x2c, true), 16);    // pages_per_block
  assert.equal(view.getUint32(0x30, true), 8192);  // clusters_per_card (8 MiB)
  assert.equal(view.getUint32(0x34, true), 41);    // alloc_offset
  assert.equal(view.getUint32(0x38, true), 8135);  // alloc_end
  assert.equal(view.getUint8(0x150), 2);           // card_type (PS2)
  assert.equal(view.getUint8(0x151), 0x52);        // card_flags
});

test('parsePSV validates magic and header requirements', () => {
  assert.throws(() => parsePSV(new Uint8Array(50)), /too small/i);

  const badMagic = new Uint8Array(0xb0);
  badMagic.set([0, 0x58, 0x58, 0x58]);
  assert.throws(() => parsePSV(badMagic), /invalid psv signature/i);

  const missingDir = new Uint8Array(0xb0);
  missingDir.set([0, 0x56, 0x53, 0x50]); // \0VSP
  assert.throws(() => parsePSV(missingDir), /could not find directory name/i);
});

function createSyntheticPSV(dirName, files) {
  const enc = new TextEncoder();
  const dirBytes = enc.encode(dirName);
  const headerSize = 0xa0 + files.length * 0x3c;
  let totalData = 0;
  for (const f of files) totalData += f.data.length;

  const totalLen = headerSize + totalData;
  const buf = new Uint8Array(totalLen);
  buf.set([0, 0x56, 0x53, 0x50]); // \0VSP

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(0x3c, 2, true); // type = PS2
  view.setUint32(0x64, files.length, true);

  buf.set(dirBytes, 0x80);

  let currentOffset = headerSize;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const entryOffset = 0xa0 + i * 0x3c;
    view.setUint32(entryOffset + 0x10, f.data.length, true);
    view.setUint32(entryOffset + 0x14, 0x8427, true);
    buf.set(enc.encode(f.name), entryOffset + 0x18);
    view.setUint32(entryOffset + 0x38, currentOffset, true);
    buf.set(f.data, currentOffset);
    currentOffset += f.data.length;
  }
  return buf;
}

test('parsePSV correctly parses synthetic PSV structure', () => {
  const iconSysData = new Uint8Array(0x100);
  iconSysData.set([0x50, 0x53, 0x32, 0x44]); // PS2D
  // Title at 0xc0: Shift-JIS or ASCII
  const titleBytes = new TextEncoder().encode('Test Save');
  iconSysData.set(titleBytes, 0xc0);

  const payload = new Uint8Array([10, 20, 30, 40]);
  const psvBytes = createSyntheticPSV('BESCES-99999test', [
    { name: 'icon.sys', data: iconSysData },
    { name: 'save.dat', data: payload }
  ]);

  const parsed = parsePSV(psvBytes);
  assert.equal(parsed.type, 2);
  assert.equal(parsed.dirName, 'BESCES-99999test');
  assert.equal(parsed.title, 'Test Save');
  assert.equal(parsed.numFiles, 2);
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[0].name, 'icon.sys');
  assert.equal(parsed.files[1].name, 'save.dat');
  assert.deepEqual(Array.from(parsed.files[1].data), [10, 20, 30, 40]);
});

test('parsePSV parses real ICO PSV file if available', () => {
  const psvPath = '/Users/kafka/Downloads/BESCES-5076069636F.PSV';
  if (!existsSync(psvPath)) return;

  const bytes = readFileSync(psvPath);
  const parsed = parsePSV(bytes);
  assert.equal(parsed.type, 2);
  assert.equal(parsed.dirName, 'BESCES-50760ico');
  assert.equal(parsed.numFiles, 13);
  assert.equal(parsed.title, 'ＩＣＯ');

  const names = parsed.files.map(f => f.name);
  assert.ok(names.includes('icon.sys'));
  assert.ok(names.includes('boy_blk.ico'));
  assert.ok(names.includes('BESCES-50760ico'));
  assert.ok(names.includes('game.000'));
  assert.ok(names.includes('game.009'));
});
