// SPDX-License-Identifier: GPL-3.0+
// Real game input check: trusted browser key events reach the running game through the page,
// worker, InputManager and DualShock 2. Uses local media (never committed) and a disposable
// Chrome profile. Calibrated for Beverly Hills Cop (Europe), SLES-54456: its language menu
// appears ~50 guest seconds after boot.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const bios = process.env.PS2_BIOS, game = process.env.GAME_ISO;
if (!bios || !game) { console.log('SKIP: set PS2_BIOS and GAME_ISO to local files'); process.exit(77); }
const out = 'artifacts/game-controls';
await mkdir(out, { recursive: true });
const port = process.env.TEST_PORT || '8097';
const server = spawn(process.execPath, ['scripts/server.mjs'], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
try {
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    const OriginalWorker = globalThis.Worker;
    globalThis.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => { if (data.metrics) globalThis.__guestSeconds = data.metrics[0]; });
      }
    };
  });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('#bios').disabled);
  await (await page.$('#bios')).uploadFile(bios);
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('BIOS mounted.'), { timeout: 60000 });
  // Mount directly; copying the whole disc into browser storage is not under test here.
  if (await page.$eval('#cache', e => e.checked)) await page.click('#cache');
  await (await page.$('#disc')).uploadFile(game);
  await page.waitForFunction(() => !document.querySelector('#play').disabled, { timeout: 60000 });
  const start = performance.now();
  await page.click('#play');
  await page.waitForFunction(() => document.querySelector('#loadbar-panel').hidden, { timeout: 180000, polling: 500 });
  const firstPicture = (performance.now() - start) / 1000;
  const guest = () => page.evaluate(() => globalThis.__guestSeconds || 0);
  const waitGuest = seconds => page.waitForFunction(s => (globalThis.__guestSeconds || 0) >= s, { timeout: 600000, polling: 200 }, seconds);
  // The language name sits on a static sky gradient; the palm trees animate elsewhere.
  const region = () => page.evaluate(() => {
    const c = document.querySelector('#canvas');
    const sx = c.width / 640, sy = c.height / 512;
    return Array.from(c.getContext('2d').getImageData(Math.round(250 * sx), Math.round(205 * sy), Math.round(140 * sx), Math.round(45 * sy)).data);
  });
  const difference = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
  const shot = name => page.$('#canvas').then(c => c.screenshot({ path: `${out}/${name}.png` }));
  const press = async key => { await page.keyboard.down(key); await new Promise(r => setTimeout(r, 400)); await page.keyboard.up(key); };

  await waitGuest(54);
  const menu = await region();
  await shot('1-language-menu');
  const t = await guest();
  await waitGuest(t + 2);
  const idle = difference(menu, await region());
  await press('ArrowRight');
  await waitGuest((await guest()) + 2.5);
  const afterRight = await region();
  await shot('2-after-right');
  const changed = difference(menu, afterRight);
  await press('ArrowLeft');
  await waitGuest((await guest()) + 2.5);
  const backLeft = difference(menu, await region());
  await press('ArrowRight');
  await waitGuest((await guest()) + 2.5);
  await press('KeyZ');
  await waitGuest((await guest()) + 5);
  const afterCross = await region();
  await shot('3-after-cross');
  const left = difference(afterRight, afterCross);

  // Pause hotkey: guest time stops, then resumes.
  await press('KeyP');
  await new Promise(r => setTimeout(r, 800));
  const pausedAt = await guest();
  await new Promise(r => setTimeout(r, 1500));
  const pausedLater = await guest();
  await press('KeyP');
  await waitGuest(pausedLater + 0.5);

  const report = { browser: await browser.version(), workload: 'Beverly Hills Cop (Europe) language menu', firstPictureSeconds: firstPicture, idleRegionDifference: idle, rightRegionDifference: changed, leftBackDifference: backLeft, crossRegionDifference: left, pausedGuestDelta: pausedLater - pausedAt, errors };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  assert.ok(idle < 2, 'Menu text should be static without input');
  assert.ok(changed > 8, 'Right should change the selected language');
  assert.ok(backLeft < 2, 'Left should return to the first language');
  assert.ok(left > 8, 'Cross should leave the language menu');
  assert.ok(pausedLater - pausedAt < 0.05, 'Pause hotkey should stop guest time');
  assert.deepEqual(errors, []);
  await page.click('#stop');
} finally { await browser?.close(); server.kill(); }
