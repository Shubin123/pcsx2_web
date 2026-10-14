// SPDX-License-Identifier: GPL-3.0+
// Real browser VM profiling. Uses disposable Chrome storage and local media.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import puppeteer from 'puppeteer-core';
assert.ok(process.env.GAME_ISO && process.env.PS2_BIOS, 'Set GAME_ISO and PS2_BIOS');
const out = process.env.OUT || 'artifacts/performance';
await mkdir(out, { recursive: true });
const port = process.env.TEST_PORT || '8096';
const server = spawn(process.execPath, ['scripts/server.mjs'], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser, ws;
try {
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  ws = new WebSocket(browser.wsEndpoint());
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let id = 0;
  const pending = new Map(), sessions = new Map(), profiling = new Set();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const key = ++id; pending.set(key, { resolve, reject });
    ws.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.addEventListener('message', async e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = m.params;
      sessions.set(sessionId, targetInfo);
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
      if (process.env.PROFILE !== '0' && targetInfo.type === 'worker') {
        try {
          await send('Profiler.enable', {}, sessionId);
          await send('Profiler.setSamplingInterval', { interval: 1000 }, sessionId);
          await send('Profiler.start', {}, sessionId);
          profiling.add(sessionId);
        } catch {}
      }
    }
    if (m.method === 'Target.detachedFromTarget') sessions.delete(m.params.sessionId);
  });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    const OriginalWorker = globalThis.Worker;
    globalThis.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'frame' || data.type === 'metrics') {
            globalThis.__vmPerf = { metrics: data.metrics, seq: data.seq ?? globalThis.__vmPerf?.seq ?? 0 };
          }
        });
      }
    };
  });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('#bios').disabled);
  await (await page.$('#bios')).uploadFile(process.env.PS2_BIOS);
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('BIOS mounted.'), { timeout: 60000 });
  await (await page.$('#disc')).uploadFile(process.env.GAME_ISO);
  await page.waitForFunction(() => !document.querySelector('#play').disabled, { timeout: 60000 });
  const bootTime = performance.now();
  await page.click('#play');
  const samples = [], hashes = new Set();
  let firstVisibleSeconds = null;
  const duration = Number(process.env.DURATION || 130);
  while ((performance.now() - bootTime) / 1000 < duration) {
    await new Promise(r => setTimeout(r, 1000));
    const sample = await page.evaluate(async () => {
      const canvas = document.querySelector('#canvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8)) visible++;
      const digest = await crypto.subtle.digest('SHA-256', pixels);
      return { ...globalThis.__vmPerf, visible, hash: Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('') };
    });
    sample.wallSeconds = (performance.now() - bootTime) / 1000;
    samples.push(sample);
    if (sample.visible > 1000) {
      if (firstVisibleSeconds === null) {
        firstVisibleSeconds = sample.wallSeconds;
        await (await page.$('#canvas')).screenshot({ path: `${out}/first-visible.png` });
      }
      hashes.add(sample.hash);
    }
    if (samples.length % 10 === 0) console.log(JSON.stringify(sample));
  }
  let n = 0;
  for (const sessionId of profiling) {
    try {
      const { profile } = await send('Profiler.stop', {}, sessionId);
      await writeFile(`${out}/worker-${n++}.cpuprofile`, JSON.stringify(profile));
    } catch {}
  }
  await (await page.$('#canvas')).screenshot({ path: `${out}/last-frame.png` });
  const manifest = JSON.parse(await readFile('web/runtime/manifest.json', 'utf8'));
  const report = { browser: await browser.version(), hardware: { cpu: cpus()[0].model, logicalCpus: cpus().length, platform: platform(), arch: arch() }, firstVisibleSeconds, visibleHashes: hashes.size, errors, vmHash: manifest.files['pcsx2-vm.wasm'].sha256, settings: { renderer: 'software', EECycleSkip: 2, EECycleRate: -2, WaitLoop: true, vu1Instant: true, frameLimit: false, extraGSThreads: 0 }, workload: 'Beverly Hills Cop (Europe), unskipped publisher intro', samples };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ firstVisibleSeconds, visibleHashes: hashes.size, profileWorkers: n, errors }));
  assert.ok(firstVisibleSeconds !== null && hashes.size >= 3, 'Require changing visible frames');
  assert.deepEqual(errors, []);
  await page.click('#stop');
} finally {
  ws?.close(); await browser?.close(); server.kill();
}
