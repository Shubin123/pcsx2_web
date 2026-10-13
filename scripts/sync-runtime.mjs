// SPDX-License-Identifier: GPL-3.0+
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const source = path.resolve(process.argv[2] || fileURLToPath(new URL('../../pcsx2_emscripten/build-web/web/', import.meta.url)));
const destination = fileURLToPath(new URL('../web/runtime/', import.meta.url));
const manifestBytes = await readFile(path.join(source, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
if (manifest.schema !== 1 || manifest.abi !== 1 || manifest.emulation !== false || manifest.kind !== 'portability-components') throw new Error('Unsupported artifact manifest');
const payloads = [];
for (const [name, meta] of Object.entries(manifest.files)) {
  if (!/^pcsx2-port\.[a-z0-9.]+$/.test(name)) throw new Error('Unsafe artifact filename');
  const bytes = await readFile(path.join(source, name));
  if (bytes.length !== meta.bytes || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw new Error(`Artifact checksum mismatch: ${name}`);
  payloads.push([name, bytes]);
}
if (!payloads.some(([name]) => name === manifest.entry) || !payloads.some(([name]) => name === 'pcsx2-port.wasm')) throw new Error('Missing required artifacts');
await mkdir(destination, { recursive: true });
for (const name of await readdir(destination)) if (name.startsWith('pcsx2-port.') && !manifest.files[name]) await unlink(path.join(destination, name));
for (const [name, bytes] of payloads) await writeFile(path.join(destination, name), bytes);
await writeFile(path.join(destination, 'manifest.json'), manifestBytes);
console.log(`Verified and synced ${payloads.length} backend artifacts (emulation=false)`);
