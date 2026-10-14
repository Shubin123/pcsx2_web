// SPDX-License-Identifier: GPL-3.0+
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { testWidgetSizing } from './layout.mjs';
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
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url() === 'https://archive.org/metadata/playstation-2-games-iso') return request.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }, body: JSON.stringify({ files: [ { name: 'Archive fixture (USA).iso', size: '1048576' }, { name: 'Other fixture (Japan).iso', size: '2048' }, { name: 'metadata.xml', size: '100' } ] }) });
    if (request.url().startsWith('https://archive.org/download/playstation-2-games-iso/')) return request.respond({ status: 200, headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }, body: Buffer.alloc(1048576, 0x42) });
    request.continue();
  });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.getElementById('validate').disabled, { timeout: 30000 });
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.equal(await page.$eval('#play', element => element.disabled), true);
  assert.equal(await page.$eval('#btn-load-game', element => element.disabled), true);
  await page.waitForFunction(() => document.getElementById('bios-name').textContent.includes('Baked-in'));
  assert.ok((await page.$eval('#bios-name', el => el.textContent)).includes('SCPH-70004 EUR v2.00'));
  assert.ok(await page.$('#loadbar'));
  assert.ok(await page.$('#loadbar-fill'));
  await page.waitForSelector('#archive-list li button');
  assert.equal(await page.$$eval('#archive-list li', rows => rows.length), 2);
  await page.click('#archive-list li button');
  await page.waitForFunction(() => document.getElementById('archive-status').textContent.includes('cached and mounted'));
  assert.ok(await page.$eval('#library', e => e.textContent.includes('Archive fixture')));
  await page.click('#library li button:last-child');
  await page.click('#btn-layout-menu');
  await page.waitForFunction(() => !document.getElementById('layout-menu').hidden);
  await page.click('[aria-label="Show Controller"]');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('[data-widget="controls"]', e => e.hidden), true);
  await page.select('#filter', 'auto');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.getElementById('validate').disabled);
  assert.equal(await page.$eval('#filter', e => e.value), 'auto');
  assert.equal(await page.$eval('[data-widget="controls"]', e => e.hidden), true);
  await page.click('#reset-settings');
  assert.equal(await page.$eval('[data-widget="controls"]', e => e.hidden), false);
  await testWidgetSizing(page);
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
  assert.equal(await page.$eval('#btn-load-game', el => el.disabled), false);
  assert.equal(await page.$eval('#play', el => el.disabled), false);
  await page.click('#btn-load-game');
  await page.waitForFunction(() => !document.getElementById('loadbar-panel').hidden);
  assert.ok((await page.$eval('#loadbar-label', el => el.textContent)).includes('Loading'));
  await page.waitForFunction(() => document.getElementById('loadbar-panel').hidden, { timeout: 15000 });
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
  await page.click('#btn-layout-menu');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/frontend-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  const report = { browser: await browser.version(), upstreamGS: 'passed', bakedInBios: 'passed', gameLoadingButton: 'passed', loadbar: 'passed', uiImport: 'passed', cachedReplay: 'passed', largeDiscBytes: result.mounted.size, largeDiscHeaderAndTail: 'passed', cancellationCleanup: 'passed', archiveDownloadCacheMount: 'passed (generated fixture)', widgetSizing: 'passed (pointer drag, scrolling, reload, sliders, columns, reset, responsive geometry)', layoutPersistence: 'passed', preferences: 'passed', mobileLayout: 'passed', gameExecution: 'not implemented' };
  await writeFile('artifacts/browser-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); server.kill(); }
