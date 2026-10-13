// SPDX-License-Identifier: GPL-3.0+
// Local proprietary inputs stay outside the repository and browser profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, stat, mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const iso = process.env.GAME_ISO;
assert.ok(iso, 'Set GAME_ISO to a local, user-provided PS2 disc image');
const info = await stat(iso);
assert.ok(info.isFile() && info.size > 0, 'GAME_ISO must be a nonempty file');
const file = await open(iso, 'r');
let header, tail;
try {
  header = Buffer.alloc(Math.min(64, info.size));
  tail = Buffer.alloc(Math.min(16, info.size));
  await file.read(header, 0, header.length, 0);
  await file.read(tail, 0, tail.length, info.size - tail.length);
} finally { await file.close(); }

const port = process.env.TEST_PORT || '8094';
const server = spawn(process.execPath, ['scripts/server.mjs'], {
  env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'],
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
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('#validate').disabled);
  await (await page.$('#disc')).uploadFile(iso);
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('end-of-file reads verified'), { timeout: 60000 });
  const selected = await page.$eval('#selected', element => element.textContent);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('#validate').disabled);
  await page.click('#library li button');
  await page.waitForFunction(expected => document.querySelector('#selected').textContent === expected, {}, selected);
  // Read the cached image through the actual Wasm WORKERFS mount, and compare
  // its bytes against the source file rather than trusting a status message.
  const mounted = await page.evaluate(async () => {
    const { listGames, getCachedFile } = await import('./storage.js');
    const { Backend } = await import('./backend.js');
    const games = await listGames();
    const backend = new Backend();
    try {
      const manifest = await backend.request('init');
      const file = await getCachedFile(games[0]);
      return { manifest, mount: await backend.request('mount', { file, kind: 'disc' }) };
    } finally { backend.dispose(); }
  });
  assert.equal(mounted.mount.size, info.size);
  assert.deepEqual(mounted.mount.header, [...header]);
  assert.deepEqual(mounted.mount.tail, [...tail]);
  assert.deepEqual(errors, []);
  const report = {
    browser: await browser.version(), discBytes: info.size,
    import: 'passed', cachedReplay: 'passed', wasmReadback: 'passed',
    emulationAvailable: mounted.manifest.emulation,
    gameplay: 'not tested by the import suite', guestFPS: null,
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/game-import-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); server.kill(); }
