// SPDX-License-Identifier: GPL-3.0+
// Layer 3: trusted key events in Chrome through the real page, worker and booted VM, read back
// from the emulated DualShock 2. Needs a local BIOS (PS2_BIOS, or web/bios.bin); boots a
// generated ELF fixture, or GAME_ISO if set. Exits 77 (skip) without a BIOS.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { padInputs, padInputCount } from './input-shared.mjs';

const bios = process.env.PS2_BIOS || (existsSync('web/bios.bin') ? 'web/bios.bin' : null);
if (!bios) { console.log('SKIP: no PS2_BIOS or web/bios.bin'); process.exit(77); }

const port = process.env.TEST_PORT || '8098';
const server = spawn(process.execPath, ['scripts/server.mjs'], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
const results = [];
const check = async (name, fn) => { await fn(); results.push(name); console.log(`ok - ${name}`); };
try {
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Keep a handle on the page's worker so the test can read the emulated pad.
  await page.evaluateOnNewDocument(() => {
    const OriginalWorker = globalThis.Worker;
    globalThis.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        if (String(args[0]).includes('core-worker')) globalThis.__coreWorker = this;
        this.addEventListener('message', ({ data }) => { if (data.metrics) globalThis.__guestSeconds = data.metrics[0]; });
      }
    };
    globalThis.__padState = () => new Promise((resolve, reject) => {
      const id = `pad-${Math.random()}`;
      const listener = ({ data }) => {
        if (data.id !== id) return;
        globalThis.__coreWorker.removeEventListener('message', listener);
        data.error ? reject(new Error(data.error)) : resolve(data.result);
      };
      globalThis.__coreWorker.addEventListener('message', listener);
      globalThis.__coreWorker.postMessage({ id, action: 'padState' });
    });
  });
  await page.setViewport({ width: 1280, height: 900 });

  const pad = () => page.evaluate(() => globalThis.__padState());
  const expected = (...ids) => { const s = new Array(padInputCount).fill(0); for (const id of ids) s[padInputs[id]] = 255; return s; };
  async function settle(state, what) {
    let last;
    for (let i = 0; i < 100; i++) {
      last = await pad();
      if (JSON.stringify(last) === JSON.stringify(state)) return;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.deepEqual(last, state, what);
  }
  const still = async (what) => { await new Promise(r => setTimeout(r, 150)); assert.deepEqual(await pad(), expected(), what); };
  async function boot() {
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !document.querySelector('#bios').disabled, { timeout: 60000 });
    // Mount directly: copying media into browser storage is not under test here.
    if (await page.$eval('#cache', e => e.checked)) await page.click('#cache');
    if (process.env.PS2_BIOS) {
      // The page ignores a second import while one runs: wait for this BIOS by name.
      const name = path.basename(process.env.PS2_BIOS);
      await (await page.$('#bios')).uploadFile(process.env.PS2_BIOS);
      await page.waitForFunction(n => document.querySelector('#bios-name').textContent.includes(n), { timeout: 60000 }, name);
    } else await page.waitForFunction(() => document.querySelector('#bios-name').textContent.includes('MiB'), { timeout: 60000 });
    if (process.env.GAME_ISO) await (await page.$('#disc')).uploadFile(process.env.GAME_ISO);
    else await page.evaluate(() => {
      const bytes = new Uint8Array(65536); bytes.set([0x7f, 0x45, 0x4c, 0x46]);
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'input-fixture.elf'));
      const input = document.getElementById('disc'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(() => !document.querySelector('#play').disabled, { timeout: 60000 });
    await page.click('#play');
    await page.waitForFunction(() => document.querySelector('#pause').disabled === false, { timeout: 60000 });
    await page.waitForFunction(() => (globalThis.__guestSeconds || 0) > 0.2, { timeout: 120000, polling: 100 });
  }
  const tap = async (key, ms = 60) => { await page.keyboard.down(key); await new Promise(r => setTimeout(r, ms)); await page.keyboard.up(key); };
  const bindings = await (async () => {
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
    return page.evaluate(async () => (await import('./keyboard.js')).defaults);
  })();

  await check('without a game, Tab keeps moving focus (no key capture)', async () => {
    await page.focus('#btn-load-game');
    const before = await page.evaluate(() => document.activeElement.id);
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement.id), before);
  });

  await boot();

  await check('every default key presses exactly its DualShock 2 input', async () => {
    for (const id of Object.keys(padInputs)) {
      await page.keyboard.down(bindings[id]);
      await settle(expected(id), `${id} via ${bindings[id]}`);
      await page.keyboard.up(bindings[id]);
      await settle(expected(), `${id} released`);
    }
  });

  await check('chords: D-pad, Cross and R2 together', async () => {
    for (const id of ['Up', 'Cross', 'R2']) await page.keyboard.down(bindings[id]);
    await settle(expected('Up', 'Cross', 'R2'));
    for (const id of ['Up', 'Cross', 'R2']) await page.keyboard.up(bindings[id]);
    await settle(expected());
  });

  await check('focus on a toolbar button: Enter is Start and does not press the button', async () => {
    await page.click('#pause'); await page.click('#pause'); // pause, resume; focus stays on the button
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pause');
    await page.keyboard.down('Enter');
    await settle(expected('Start'));
    await page.keyboard.up('Enter');
    await settle(expected());
    assert.equal(await page.$eval('#pause', e => e.textContent), 'Pause', 'the game was not paused by Enter');
  });

  await check('focus on a settings select: arrows drive the D-pad, not the select', async () => {
    await page.focus('#aspect');
    const value = await page.$eval('#aspect', e => e.value);
    await page.keyboard.down('ArrowDown');
    await settle(expected('Down'));
    await page.keyboard.up('ArrowDown');
    await settle(expected());
    assert.equal(await page.$eval('#aspect', e => e.value), value);
  });

  await check('typing in a text field does not reach the game', async () => {
    await page.focus('#archive-search');
    await page.keyboard.type('zx');
    await still('typing');
    assert.equal(await page.$eval('#archive-search', e => e.value), 'zx');
    await page.$eval('#archive-search', e => { e.value = ''; });
  });

  await check('clicking the game screen gives keys back to the game', async () => {
    await page.click('#canvas');
    await page.keyboard.down(bindings.Cross);
    await settle(expected('Cross'));
    await page.keyboard.up(bindings.Cross);
    await settle(expected());
  });

  await check('browser shortcuts (Ctrl+key) are not sent to the game', async () => {
    await page.keyboard.down('Control');
    await page.keyboard.down(bindings.Cross);
    await still('Ctrl+Cross key');
    await page.keyboard.up(bindings.Cross);
    await page.keyboard.up('Control');
  });

  await check('losing focus releases held keys', async () => {
    await page.keyboard.down(bindings.Cross);
    await settle(expected('Cross'));
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await settle(expected(), 'released on blur');
    await page.keyboard.up(bindings.Cross);
  });

  await check('P pauses (controller keys ignored) and resumes', async () => {
    await tap(bindings.pause);
    await page.waitForFunction(() => document.querySelector('#pause').textContent === 'Resume');
    const t = await page.evaluate(() => globalThis.__guestSeconds);
    await tap(bindings.Cross);
    await still('paused');
    await new Promise(r => setTimeout(r, 600));
    assert.ok(Math.abs(await page.evaluate(() => globalThis.__guestSeconds) - t) < 0.05, 'guest time stopped');
    await tap(bindings.pause);
    await page.waitForFunction(() => document.querySelector('#pause').textContent === 'Pause');
    await page.keyboard.down(bindings.Cross);
    await settle(expected('Cross'));
    await page.keyboard.up(bindings.Cross);
    await settle(expected());
  });

  await check('holding Tab (fast-forward) keeps focus and touches no controller input', async () => {
    await page.click('#canvas');
    await page.keyboard.down('Tab');
    await still('fast-forward');
    await page.keyboard.up('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'screen');
  });

  await check('rebinding in the Controller widget applies to the running game', async () => {
    await page.click('#key-bindings button[data-action="Cross"]');
    await page.waitForFunction(() => document.querySelector('#key-bindings button[data-action="Cross"]').textContent.startsWith('Press'));
    await page.keyboard.press('KeyB');
    assert.equal(await page.$eval('#key-bindings button[data-action="Cross"]', e => e.textContent), 'B');
    await page.click('#canvas');
    await tap(bindings.Cross); // the old key no longer presses Cross
    await still('old key');
    await page.keyboard.down('KeyB');
    await settle(expected('Cross'));
    await page.keyboard.up('KeyB');
    await settle(expected());
  });

  await check('a rebinding persists across reload and applies at the next boot', async () => {
    await boot();
    assert.equal(await page.$eval('#key-bindings button[data-action="Cross"]', e => e.textContent), 'B');
    await page.click('#canvas');
    await page.keyboard.down('KeyB');
    await settle(expected('Cross'));
    await page.keyboard.up('KeyB');
    await settle(expected());
  });

  await check('Reset keys restores the default layout in the running game', async () => {
    await page.click('#reset-keys');
    await page.click('#canvas');
    await page.keyboard.down(bindings.Cross);
    await settle(expected('Cross'));
    await page.keyboard.up(bindings.Cross);
    await settle(expected());
  });

  assert.deepEqual(errors, []);
  await page.click('#stop');
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/input-browser-report.json', JSON.stringify({ browser: await browser.version(), disc: process.env.GAME_ISO ? 'GAME_ISO' : 'generated ELF fixture', passed: results }, null, 2) + '\n');
  console.log(`PASS: ${results.length} browser input checks`);
} finally { await browser?.close(); server.kill(); }
