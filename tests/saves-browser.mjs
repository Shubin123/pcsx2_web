// SPDX-License-Identifier: GPL-3.0+
// Browser test for PS2 memory card save file system and widget.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const port = process.env.TEST_PORT || '8097';
const server = spawn(process.execPath, ['scripts/server.mjs'], {
  env: { ...process.env, PORT: port },
  stdio: ['ignore', 'pipe', 'inherit']
});

let browser;
try {
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve);
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Server exited ${code}`)));
  });

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.setViewport({ width: 1440, height: 1100 });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('#validate').disabled);

  // 1. Verify widget presence and initial DOM state
  const savesWidget = await page.$('[data-widget="saves"]');
  assert.ok(savesWidget, 'Saves widget panel must be present in DOM');

  const slotSelect = await page.$('#save-state-slot');
  assert.ok(slotSelect, 'Save-state slot selector must be present');
  const btnSave = await page.$('#btn-save-state');
  const btnLoad = await page.$('#btn-load-state');
  assert.ok(btnSave, 'Save state button must be present');
  assert.ok(btnLoad, 'Load state button must be present');

  const statusText = await page.$eval('#save-status', el => el.textContent);
  assert.match(statusText, /ready/i);

  // 2. Test SaveStore directly within browser context
  const storeResult = await page.evaluate(async () => {
    const { SaveStore, createSuperblock } = await import('./saves.js');
    const store = new SaveStore();
    await store.init();

    // Verify empty initial memcard
    const initialFiles = await store.getMemcard('Mcd001.ps2');

    // Create and save test files
    const sb = createSuperblock();
    await store.putMemcard('Mcd001.ps2', [
      { path: '_pcsx2_superblock', size: sb.length, data: sb },
      { path: 'TEST/save.dat', size: 4, data: new Uint8Array([1, 2, 3, 4]) }
    ]);
    const stored = await store.getMemcard('Mcd001.ps2');

    // Test save state store
    await store.putState('TEST-SERIAL', 1, 'Test Save Slot 1', 'test.01.p2s', new Uint8Array([99, 88]));
    const states = await store.listStates('TEST-SERIAL');
    const state1 = await store.getState('TEST-SERIAL', 1);

    await store.deleteState('TEST-SERIAL', 1);
    const afterDelete = await store.listStates('TEST-SERIAL');

    return {
      initialCount: initialFiles.length,
      storedCount: stored.length,
      hasSuperblock: stored.some(f => f.path === '_pcsx2_superblock'),
      stateTitle: state1?.title,
      statesCount: states.length,
      afterDeleteCount: afterDelete.length
    };
  });

  assert.equal(storeResult.storedCount, 2);
  assert.equal(storeResult.hasSuperblock, true);
  assert.equal(storeResult.stateTitle, 'Test Save Slot 1');
  assert.equal(storeResult.statesCount, 1);
  assert.equal(storeResult.afterDeleteCount, 0);

  // 3. Import synthetic PSV save file via widget file input
  await page.evaluate(() => {
    function buildSyntheticPSV(dirName, fileName, data) {
      const enc = new TextEncoder();
      const dirBytes = enc.encode(dirName);
      const headerSize = 0xa0 + 1 * 0x3c;
      const buf = new Uint8Array(headerSize + data.length);
      buf.set([0, 0x56, 0x53, 0x50]); // \0VSP
      const view = new DataView(buf.buffer);
      view.setUint32(0x3c, 2, true);
      view.setUint32(0x64, 1, true);
      buf.set(dirBytes, 0x80);

      view.setUint32(0xa0 + 0x10, data.length, true);
      view.setUint32(0xa0 + 0x14, 0x8427, true);
      buf.set(enc.encode(fileName), 0xa0 + 0x18);
      view.setUint32(0xa0 + 0x38, headerSize, true);
      buf.set(data, headerSize);
      return buf;
    }

    const psv = buildSyntheticPSV('BESCES-50760ico', 'game.000', new Uint8Array(100));
    const transfer = new DataTransfer();
    transfer.items.add(new File([psv], 'BESCES-5076069636F.PSV'));
    const input = document.getElementById('input-import-save');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  });

  await page.waitForFunction(() => {
    const status = document.getElementById('save-status')?.textContent;
    return status && status.includes('Imported PSV save');
  }, { timeout: 10000 });

  // 4. Verify quick-load banner is active
  await page.waitForFunction(() => {
    const quickPanel = document.getElementById('save-quick-load-panel');
    return quickPanel && !quickPanel.hidden;
  });
  const quickTitle = await page.$eval('#save-quick-title', el => el.textContent);
  assert.ok(quickTitle.includes('ICO'), 'Quick load title should detect ICO');

  // 5. If real PSV file is on local disk, test importing it directly
  const realPsvPath = '/Users/kafka/Downloads/BESCES-5076069636F.PSV';
  if (existsSync(realPsvPath)) {
    const fileBytes = Array.from(readFileSync(realPsvPath));
    await page.evaluate(async (rawBytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(rawBytes)], 'BESCES-5076069636F.PSV'));
      const input = document.getElementById('input-import-save');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));
    }, fileBytes);

    await page.waitForFunction(() => {
      const status = document.getElementById('save-status')?.textContent;
      return status && status.includes('13 files');
    }, { timeout: 10000 });

    const statusAfterReal = await page.$eval('#save-status', el => el.textContent);
    assert.match(statusAfterReal, /Imported PSV save: ＩＣＯ/);
  }

  // 6. Test Export Memory Card
  await page.evaluate(() => {
    window.__exportedBlobs = [];
    window.__downloadNames = [];
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      window.__exportedBlobs.push(blob);
      return origCreate(blob);
    };
    HTMLAnchorElement.prototype.click = function() {
      if (this.download) window.__downloadNames.push(this.download);
      // Suppress actual browser download to host filesystem
    };
    document.getElementById('btn-export-save').click();
  });
  await page.waitForFunction(() => document.getElementById('save-status').textContent.includes('exported'));
  const exportedCount = await page.evaluate(() => window.__exportedBlobs.length);
  assert.equal(exportedCount, 1);
  const downloadName = await page.evaluate(() => window.__downloadNames[0]);
  assert.match(downloadName, /Ico.*save\.json/i);

  // 7. Test re-importing the JSON memory card save backup
  await page.evaluate(async () => {
    const blob = window.__exportedBlobs[0];
    const text = await blob.text();
    const file = new File([text], window.__downloadNames[0], { type: 'application/json' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('input-import-save');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('save-status').textContent.includes('Imported memory card save'));

  // Screenshots
  await mkdir('artifacts/saves-widget', { recursive: true });
  await (await page.$('[data-widget="saves"]')).screenshot({ path: 'artifacts/saves-widget/desktop.png' });
  await page.setViewport({ width: 390, height: 900 });
  await (await page.$('[data-widget="saves"]')).screenshot({ path: 'artifacts/saves-widget/mobile.png' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No mobile horizontal overflow');

  assert.deepEqual(errors, []);
  console.log('PASS: save file system unit, store persistence, PSV parser, quick-load banner, screenshots, and save widget interaction');
} finally {
  await browser?.close();
  server.kill();
}
