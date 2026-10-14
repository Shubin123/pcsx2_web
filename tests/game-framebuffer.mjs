// SPDX-License-Identifier: GPL-3.0+
// Exercise the actual UI and canvas with local user-owned media.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

assert.ok(process.env.GAME_ISO && process.env.PS2_BIOS, 'Set GAME_ISO and PS2_BIOS to local media');
const port = process.env.TEST_PORT || '8095';
const server = spawn(process.execPath, ['scripts/server.mjs'], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
try {
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(process.env.TEST_URL || `http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('#bios').disabled);
  await (await page.$('#bios')).uploadFile(process.env.PS2_BIOS);
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('BIOS mounted.'), { timeout: 60000 });
  await (await page.$('#disc')).uploadFile(process.env.GAME_ISO);
  await page.waitForFunction(() => !document.querySelector('#play').disabled, { timeout: 60000 });
  await page.click('#play');
  const hashes = new Set();
  const samples = [];
  const deadline = Date.now() + Number(process.env.PCSX2_GAME_TIMEOUT_SECONDS || 240) * 1000;
  await mkdir('artifacts/game-framebuffers', { recursive: true });
  while (Date.now() < deadline && hashes.size < 3) {
    await new Promise(r => setTimeout(r, 1000));
    const sample = await page.evaluate(async () => {
      const canvas = document.querySelector('#canvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = 0, transparent = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] !== 255) transparent++;
        if (data[i + 3] && (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8)) visible++;
      }
      const digest = await crypto.subtle.digest('SHA-256', data);
      return { visible, transparent, hash: Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join(''), width: canvas.width, height: canvas.height, status: document.querySelector('#status').textContent, fps: document.querySelector('#fps').textContent };
    });
    if (sample.visible > 1000 && !hashes.has(sample.hash)) {
      hashes.add(sample.hash); samples.push(sample);
      await (await page.$('#canvas')).screenshot({ path: `artifacts/game-framebuffers/frame-${hashes.size}.png` });
      console.log(JSON.stringify(sample));
    }
  }
  assert.equal(hashes.size, 3, 'Game must produce three distinct visible canvas framebuffers');
  assert.ok(samples.every(s => s.transparent === 0), 'Presented frames must be opaque');
  assert.equal(await page.$eval('#loadbar-panel', e => e.hidden), true, 'Startup overlay clears when visible video arrives');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'artifacts/game-framebuffers/browser.png' });
  await writeFile('artifacts/game-framebuffers/report.json', JSON.stringify({ browser: await browser.version(), samples, errors }, null, 2) + '\n');
  await page.click('#stop');
  console.log('PASS: real game canvas has changing, visible, opaque frames');
} finally {
  await browser?.close(); server.kill();
}
