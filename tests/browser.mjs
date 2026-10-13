// SPDX-License-Identifier: GPL-3.0+
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const port = process.env.TEST_PORT || '8093';
const server = spawn(process.execPath, ['scripts/server.mjs'], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
const errors = [];
try {
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error(`Server exited ${code}`))); });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.getElementById('validate').disabled, { timeout: 30000 });
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.equal(await page.$eval('#play', element => element.disabled), true);
  await page.click('#validate');
  await page.waitForFunction(() => document.getElementById('validation').textContent.startsWith('Passed:'));
  // Exercise the actual UI import path and the storage replay path after reload.
  await page.evaluate(() => {
    const bytes = new Uint8Array(1024 * 1024);
    bytes.set([0x7f, 0x45, 0x4c, 0x46]); bytes.set([8, 7, 6, 5], bytes.length - 4);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'homebrew-test.elf'));
    const input = document.getElementById('disc'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('end-of-file reads verified'));
  assert.ok(await page.$eval('#library', element => element.textContent.includes('homebrew-test.elf')));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.getElementById('validate').disabled);
  await page.waitForFunction(() => document.querySelector('#library li button'));
  await page.click('#library li button');
  await page.waitForFunction(() => document.getElementById('selected').textContent.includes('homebrew-test.elf'));
  const result = await page.evaluate(async () => {
    const { Backend } = await import('./backend.js');
    const { cacheFile, listGames } = await import('./storage.js');
    const backend = new Backend();
    try {
      await backend.request('init');
      // A sparse OPFS file proves offsets above signed 32-bit range without
      // allocating a multi-GiB JS ArrayBuffer or shipping any game data.
      const workerCode = `onmessage = async () => {
        let dir, handle;
        try {
          dir = await navigator.storage.getDirectory();
          const file = await dir.getFileHandle('large-disc-test.iso', {create:true});
          handle = await file.createSyncAccessHandle();
          handle.truncate(3 * 1024 * 1024 * 1024 + 16);
          handle.write(new Uint8Array([0x50,0x53,0x32,0]), {at:0});
          handle.write(new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]), {at:3 * 1024 * 1024 * 1024});
          handle.flush(); handle.close(); handle = null;
          postMessage({file:await file.getFile()});
        } catch (error) { handle?.close(); postMessage({error:error.message}); }
      };`;
      const url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
      const worker = new Worker(url);
      let large;
      try {
        large = await new Promise((resolve, reject) => { worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.file); worker.onerror = reject; worker.postMessage({}); });
      } finally { worker.terminate(); URL.revokeObjectURL(url); }
      let mounted;
      try { mounted = await backend.request('mount', { file: large, kind: 'disc' }); }
      finally { await (await navigator.storage.getDirectory()).removeEntry('large-disc-test.iso'); }
      const before = (await listGames()).length;
      const controller = new AbortController(); controller.abort();
      let canceled = false;
      try { await cacheFile(new File([new Uint8Array(65536)], 'canceled.elf'), 'disc', () => {}, controller.signal); }
      catch (error) { canceled = error.name === 'AbortError'; }
      return { mounted, canceled, clean: (await listGames()).length === before };
    } finally { backend.dispose(); }
  });
  assert.deepEqual(result.mounted.header.slice(0, 4), [0x50, 0x53, 0x32, 0]);
  assert.deepEqual(result.mounted.tail, Array.from({ length: 16 }, (_, i) => i + 1));
  assert.equal(result.mounted.size, 3 * 1024 * 1024 * 1024 + 16);
  assert.equal(result.canceled, true); assert.equal(result.clean, true);
  await page.click('#library li button:last-child');
  await page.waitForFunction(() => !document.querySelector('#library li'));
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/frontend-desktop.png', fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/frontend-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  const report = { browser: await browser.version(), upstreamGS: 'passed', uiImport: 'passed', cachedReplay: 'passed', largeDiscBytes: result.mounted.size, largeDiscHeaderAndTail: 'passed', cancellationCleanup: 'passed', mobileLayout: 'passed', gameExecution: 'not implemented' };
  await writeFile('artifacts/browser-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); server.kill(); }
