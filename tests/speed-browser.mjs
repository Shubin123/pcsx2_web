// SPDX-License-Identifier: GPL-3.0+
// Real range/preset interaction, preference persistence, layout integration, and the
// worker speed command. Gameplay timing is measured by the backend ICO browser harness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const port = process.env.TEST_PORT || '8099';
const server = spawn(process.execPath, ['scripts/server.mjs'], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
try {
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    globalThis.__speedCommands = [];
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...rest) {
      if (message.action === 'limiter') globalThis.__speedCommands.push(message.data);
      return original.call(this, message, ...rest);
    };
  });
  await page.setViewport({ width: 1440, height: 1100 });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('#validate').disabled);
  await page.waitForSelector('[data-widget="speed"] .widget-resize');
  const selected = () => page.$eval('#speed-value', e => e.textContent);
  assert.equal(await selected(), '1×');
  await page.click('[data-speed="2"]');
  assert.equal(await selected(), '2×');
  assert.deepEqual(await page.evaluate(() => __speedCommands.at(-1)), { mode: 1, scalar: 2 });
  await page.focus('#speed'); await page.keyboard.press('End');
  assert.equal(await selected(), '3×');
  assert.deepEqual(await page.evaluate(() => __speedCommands.at(-1)), { mode: 1, scalar: 3 });
  assert.equal(await page.$eval('[data-speed="3"]', e => e.getAttribute('aria-pressed')), 'true');
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await selected(), '3×');
  await page.click('#btn-layout-menu');
  assert.ok(await page.$('[aria-label="Show Emulation speed"]'), 'Speed must be an independent layout widget');
  await page.keyboard.press('Escape');
  await mkdir('artifacts/speed-widget', { recursive: true });
  await (await page.$('[data-widget="speed"]')).screenshot({ path: 'artifacts/speed-widget/desktop.png' });
  await page.setViewport({ width: 390, height: 900 });
  await (await page.$('[data-widget="speed"]')).screenshot({ path: 'artifacts/speed-widget/mobile.png' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No mobile horizontal overflow');
  await page.click('#reset-settings');
  assert.equal(await selected(), '1×');
  assert.deepEqual(await page.evaluate(() => __speedCommands.at(-1)), { mode: 0, scalar: 1 });
  assert.deepEqual(errors, []);
  console.log('PASS: independent speed widget, 1×/2×/3× commands, keyboard slider, persistence, reset, and mobile layout');
} finally { await browser?.close(); server.kill(); }
