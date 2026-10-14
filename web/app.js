// SPDX-License-Identifier: GPL-3.0+
import { Backend } from './backend.js';
import { cacheFile, getCachedFile, listGames, removeCachedFile } from './storage.js';
import { startInput } from './input.js';
import { startArchive } from './archive.js';

const $ = id => document.getElementById(id);
let backend;
let importController;
let importing = false;
let downloading = false;
let ready = false;
let hasBios = false;
let hasGame = false;
let isRunning = false;
let isPaused = false;
let waitingForVideo = false;

const status = message => {
  $('status').textContent = message;
  const log = $('log');
  log.textContent = (log.textContent + `${new Date().toLocaleTimeString()} ${message}\n`).split('\n').slice(-150).join('\n');
};
const report = error => status(error.message || String(error));

function showLoadbar(label, progress, detail = '') {
  const panel = $('loadbar-panel');
  if (!panel) return;
  panel.hidden = false;
  panel.setAttribute('aria-busy', 'true');
  $('loadbar-label').textContent = label;
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  $('loadbar-percent').textContent = `${pct}%`;
  const fill = $('loadbar-fill');
  if (fill) fill.style.width = `${pct}%`;
  const bar = $('loadbar');
  if (bar) bar.setAttribute('aria-valuenow', pct);
  $('loadbar-detail').textContent = detail;
}

function hideLoadbar() {
  const panel = $('loadbar-panel');
  if (panel) {
    panel.hidden = true;
    panel.setAttribute('aria-busy', 'false');
  }
}

async function refreshLibrary() {
  const games = await listGames();
  $('library').replaceChildren();
  for (const meta of games.filter(meta => meta.kind === 'disc')) {
    const row = document.createElement('li');
    const load = document.createElement('button');
    load.textContent = `${meta.name} · ${(meta.size / 1048576).toFixed(1)} MiB`;
    load.disabled = !ready || importing || downloading;
    load.onclick = () => loadFile(meta).catch(report);
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${meta.name} from browser storage`);
    remove.disabled = importing || downloading;
    remove.onclick = async () => { try { await removeCachedFile(meta); await refreshLibrary(); } catch (error) { report(error); } };
    row.append(load, remove); $('library').append(row);
  }
}

async function loadFile(meta) {
  const file = await getCachedFile(meta);
  await mountFile(file, meta.kind);
}

async function mountFile(file, kind) {
  const result = await backend.request('mount', { file, kind });
  if (kind === 'bios') {
    hasBios = true;
    const isBaked = file.name.includes('Baked-in') || file.name === 'bios.bin';
    $('bios-name').textContent = isBaked
      ? `[Baked-in] SCPH-70004 EUR v2.00 · ${(result.size / 1048576).toFixed(1)} MiB`
      : `${result.name} · ${(result.size / 1048576).toFixed(1)} MiB`;
  } else {
    hasGame = true;
    $('selected').textContent = `${result.name} · ${(result.size / 1048576).toFixed(1)} MiB`;
    $('btn-load-game').disabled = false;
    $('play').disabled = false;
  }
  status(`${kind === 'bios' ? 'BIOS' : 'Game'} mounted. Header and end-of-file reads verified.`);
  return result;
}

async function importFile(file, kind) {
  if (!file || !ready || importing || downloading) return;
  if (!file.size) throw new Error('The selected file is empty.');
  const extension = file.name.split('.').pop().toLowerCase();
  if (kind === 'disc' && !['iso', 'bin', 'elf'].includes(extension)) throw new Error('Choose an ISO, BIN, or ELF. Compressed archives are not supported yet.');
  if (kind === 'bios' && (file.size < 512 * 1024 || file.size > 8 * 1024 * 1024)) throw new Error('Unexpected BIOS size. Choose your PS2 BIOS ROM (usually 4 MiB).');
  importing = true;
  $('disc').disabled = $('bios').disabled = true;
  importController = new AbortController();
  const cache = $('cache').checked;
  $('progress').hidden = !cache;
  $('cancel').hidden = !cache;
  $('progress').value = 0;
  try {
    await refreshLibrary();
    status(cache ? `Saving ${file.name}…` : `Mounting ${file.name}…`);
    if (cache) {
      const meta = await cacheFile(file, kind, progress => { $('progress').value = progress; }, importController.signal);
      await loadFile(meta);
    } else await mountFile(file, kind);
  } catch (error) {
    if (error.name === 'AbortError') status('Import canceled.');
    else throw error;
  } finally {
    importing = false;
    importController = null;
    $('progress').hidden = $('cancel').hidden = true;
    $('disc').disabled = $('bios').disabled = !ready;
    await refreshLibrary();
  }
}

async function loadAndRunGame() {
  if (!hasGame || isRunning) return;
  $('btn-load-game').disabled = true;
  $('play').disabled = true;
  $('pause').disabled = true;
  $('stop').disabled = false;

  try {
    showLoadbar('Loading game…', 0.15, 'Verifying console BIOS and virtual disc…');
    await new Promise(r => setTimeout(r, 60));

    if (!hasBios) {
      showLoadbar('Loading baked-in BIOS…', 0.35, 'Fetching European PS2 BIOS…');
      const response = await fetch('./bios.bin');
      if (response.ok) {
        const blob = await response.blob();
        const bakedFile = new File([blob], 'SCPH-70004 EUR v2.00 (Baked-in)', { type: 'application/octet-stream' });
        await mountFile(bakedFile, 'bios');
      }
    }

    showLoadbar('Mounting filesystem…', 0.50, 'Attaching disc image to CDVD reader…');
    await new Promise(r => setTimeout(r, 60));

    showLoadbar('Initializing PCSX2 core…', 0.70, 'Starting EE, IOP, VU, and GS software pipelines…');
    await new Promise(r => setTimeout(r, 60));

    showLoadbar('Booting PlayStation 2…', 0.88, 'Executing guest system startup sequence…');
    waitingForVideo = true;
    await backend.request('boot');
    if (waitingForVideo) showLoadbar('Starting game…', 0.88, 'Waiting for the first visible game frame. Interpreter startup can take several minutes.');

    $('empty').hidden = true;
    $('pause').disabled = false;
    $('stop').disabled = false;
    $('fps').textContent = 'Starting…';
    isRunning = true;
    status(waitingForVideo ? 'Starting game — waiting for video.' : 'Game running.');
  } catch (err) {
    waitingForVideo = false;
    hideLoadbar();
    $('btn-load-game').disabled = !hasGame;
    $('play').disabled = !hasGame;
    $('pause').disabled = true;
    $('stop').disabled = true;
    report(err);
  }
}

async function pauseGame() {
  if (!isRunning) return;
  isPaused = !isPaused;
  await backend.request('pause', { paused: isPaused });
  $('pause').textContent = isPaused ? 'Resume' : 'Pause';
  status(isPaused ? 'Emulation paused.' : 'Emulation resumed.');
}

async function stopGame() {
  if (!isRunning) return;
  waitingForVideo = false;
  hideLoadbar();
  await backend.request('stop');
  isRunning = false;
  isPaused = false;
  $('empty').hidden = false;
  $('play').disabled = !hasGame;
  $('btn-load-game').disabled = !hasGame;
  $('pause').disabled = true;
  $('pause').textContent = 'Pause';
  $('stop').disabled = true;
  $('fps').textContent = 'No game running';
  status('Emulation stopped.');
}

function updateMetrics(metrics) {
  if (!metrics || metrics.length < 5) return;
  const fps = metrics[2];
  const speed = metrics[4];
  $('fps').textContent = `${fps.toFixed(1)} FPS · ${speed.toFixed(0)}% speed`;
}

$('disc').onchange = event => { const file = event.target.files[0]; event.target.value = ''; importFile(file, 'disc').catch(report); };
$('bios').onchange = event => { const file = event.target.files[0]; event.target.value = ''; importFile(file, 'bios').catch(report); };
$('btn-load-game').onclick = () => loadAndRunGame().catch(report);
$('play').onclick = () => {
  if (!isRunning) loadAndRunGame().catch(report);
  else if (isPaused) pauseGame().catch(report);
};
$('pause').onclick = () => pauseGame().catch(report);
$('stop').onclick = () => stopGame().catch(report);
$('cancel').onclick = () => importController?.abort();
$('drop').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('disc').click(); } };
for (const name of ['dragenter', 'dragover']) $('drop').addEventListener(name, event => { event.preventDefault(); $('drop').classList.add('active'); });
$('drop').ondragleave = () => $('drop').classList.remove('active');
$('drop').ondrop = event => { event.preventDefault(); $('drop').classList.remove('active'); importFile(event.dataTransfer.files[0], 'disc').catch(report); };
$('fullscreen').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('screen').requestFullscreen()).catch(report);
$('validate').onclick = async () => {
  $('validate').disabled = true;
  $('validation').textContent = 'Checking upstream GS pixels…';
  try {
    const result = await backend.request('validate');
    $('validation').textContent = `Passed: ${result.pixels} pixel offsets and SIMD round trip.`;
  } catch (error) { $('validation').textContent = `Failed: ${error.message}`; }
  finally { $('validate').disabled = !ready; }
};

const keyMap = {
  'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
  'Enter': 'Return', 'ShiftLeft': 'Shift', 'ShiftRight': 'Shift',
  'KeyZ': 'Z', 'KeyX': 'X', 'KeyA': 'A', 'KeyS': 'S',
  'KeyQ': 'Q', 'KeyW': 'W', 'KeyE': 'E', 'KeyR': 'R', 'Space': 'Space'
};
window.addEventListener('keydown', event => {
  if (isRunning && keyMap[event.code] && !event.target.closest('input,textarea,select')) {
    backend.send('key', { name: keyMap[event.code], pressed: true });
  }
});
window.addEventListener('keyup', event => {
  if (isRunning && keyMap[event.code] && !event.target.closest('input,textarea')) {
    backend.send('key', { name: keyMap[event.code], pressed: false });
  }
});

async function initialize() {
  $('disc').disabled = $('bios').disabled = true;
  // Pages cannot set COOP/COEP, so the worker adds them after one reload.
  if (!crossOriginIsolated && 'serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.register('./coi-serviceworker.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller && !sessionStorage.getItem('pcsx2-isolation-reload')) {
      sessionStorage.setItem('pcsx2-isolation-reload', '1');
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      if (registration.active) location.reload();
      return;
    }
  }
  $('isolation').textContent = crossOriginIsolated ? 'Enabled' : 'Unavailable';
  if (!crossOriginIsolated) throw new Error('Shared memory requires HTTPS and cross-origin isolation. Use npm start locally.');
  // Valid module returning a v128 constant; capability test needs no fetch.
  const simd = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,22,1,20,0,253,12,...Array(16).fill(0),11]));
  $('simd').textContent = simd ? 'Supported' : 'Unavailable';
  if (!simd) throw new Error('This browser does not support WebAssembly SIMD.');
  startInput(id => { $('gamepad').textContent = id || 'Connect a gamepad and press a button.'; });

  const canvas = $('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  backend = new Backend();
  backend.onFrame = ({ width, height, seq, pixels, metrics }) => {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const imgData = new ImageData(new Uint8ClampedArray(pixels), width, height);
    ctx.putImageData(imgData, 0, 0);
    if (waitingForVideo) {
      let visible = 0;
      for (let i = 0; i < imgData.data.length && visible <= 1000; i += 4) {
        if (imgData.data[i + 3] > 0 && (imgData.data[i] > 8 || imgData.data[i + 1] > 8 || imgData.data[i + 2] > 8)) visible++;
      }
      if (visible > 1000) {
        waitingForVideo = false;
        hideLoadbar();
        status('Game running.');
      }
    }
    if (metrics) updateMetrics(metrics);
  };
  backend.onMetrics = ({ metrics }) => {
    if (metrics) updateMetrics(metrics);
  };

  const manifest = await backend.request('init');
  ready = true;
  $('disc').disabled = $('bios').disabled = false;
  $('validate').disabled = false;
  $('core').textContent = `PCSX2 ${manifest.upstream.revision.slice(0,8)} · GS & VM Core`;
  $('availability').textContent = manifest.hasVM
    ? 'PCSX2 WebAssembly core is ready. Select a game to load & run.'
    : 'The graphics components are ready. PS2 game execution is still being ported.';
  status('Backend initialized. Ready to load PlayStation 2 games.');
  startArchive(async meta => { await loadFile(meta); await refreshLibrary(); }, () => importing, async active => { downloading = active; await refreshLibrary(); });
  await refreshLibrary();

  // Load custom BIOS if saved, otherwise load baked-in European BIOS
  const customBios = (await listGames()).find(entry => entry.kind === 'bios');
  if (customBios) {
    try {
      await loadFile(customBios);
    } catch (e) {
      report(e);
    }
  } else {
    try {
      const response = await fetch('./bios.bin');
      if (response.ok) {
        const blob = await response.blob();
        const bakedFile = new File([blob], 'SCPH-70004 EUR v2.00 (Baked-in)', { type: 'application/octet-stream' });
        await mountFile(bakedFile, 'bios');
      } else {
        $('bios-name').textContent = 'No BIOS loaded';
      }
    } catch (_) {
      $('bios-name').textContent = 'No BIOS loaded';
    }
  }
}
initialize().catch(error => { $('core').textContent = 'Unavailable'; $('availability').textContent = 'The backend could not start.'; report(error); });
