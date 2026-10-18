// SPDX-License-Identifier: GPL-3.0+
import { Backend } from './backend.js';
import { cacheFile, getCachedFile, listGames, removeCachedFile } from './storage.js';
import { startInput } from './input.js';
import { startArchive } from './archive.js';
import { Keyboard, actions, keyLabel } from './keyboard.js';
import { initSaves } from './saves.js';

const $ = id => document.getElementById(id);
const WORKER_PROTOCOL = 2; // Must match core-worker.js.
let backend;
let savesWidget;
let importController;
let importing = false;
let downloading = false;
let ready = false;
let hasBios = false;
let hasGame = false;
let isRunning = false;
let launching = false;
let isPaused = false;
let waitingForVideo = false;
let fastForward = false;
const keyboard = new Keyboard();

// Startup and the held fast-forward hotkey temporarily override the saved target.
const speedTarget = () => Math.max(1, Math.min(3, Number($('speed').value) || 1));
const updateLimiter = () => backend?.send('limiter', {
  mode: waitingForVideo || fastForward ? 3 : speedTarget() > 1 ? 1 : 0,
  scalar: speedTarget()
});
function updateSpeedWidget() {
  const target = speedTarget();
  $('speed-value').textContent = `${target}×`;
  $('speed').setAttribute('aria-valuetext', `${target} times normal speed`);
  for (const button of document.querySelectorAll('[data-speed]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === target));
  }
  updateLimiter();
}
$('speed').addEventListener('input', updateSpeedWidget);
window.addEventListener('pcsx2-preferences-changed', updateSpeedWidget);
for (const button of document.querySelectorAll('[data-speed]')) button.onclick = () => {
  $('speed').value = button.dataset.speed;
  $('speed').dispatchEvent(new Event('input', { bubbles: true }));
  $('speed').dispatchEvent(new Event('change', { bubbles: true }));
  if (isRunning) $('screen').focus({ preventScroll: true });
};

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
  const games = (await listGames()).filter(meta => meta.kind === 'disc');
  const query = $('library-search').value.trim().toLowerCase();
  const matches = games.filter(meta => meta.name.toLowerCase().includes(query));
  $('library-status').textContent = !games.length
    ? 'No saved games yet. Choose a game file or browse the shared library to cache one.'
    : !matches.length ? 'No saved games match your search.'
    : `${matches.length} of ${games.length} saved games. Play a saved title without downloading again.`;
  $('library').replaceChildren();
  for (const meta of matches) {
    const row = document.createElement('li');
    const load = document.createElement('button');
    load.textContent = `${meta.name} · ${(meta.size / 1048576).toFixed(1)} MiB`;
    load.setAttribute('aria-label', `Load ${meta.name} from browser storage`);
    load.disabled = !ready || importing || downloading || launching || isRunning;
    load.onclick = () => loadFile(meta).catch(report);
    const play = document.createElement('button');
    play.textContent = 'Play';
    play.setAttribute('aria-label', `Play ${meta.name} from browser storage`);
    play.disabled = !ready || importing || downloading || launching;
    play.onclick = () => loadAndRunGame(meta).catch(report);
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${meta.name} from browser storage`);
    remove.disabled = importing || downloading || launching;
    remove.onclick = async () => { try { await removeCachedFile(meta); await refreshLibrary(); } catch (error) { report(error); } };
    row.append(load, play, remove); $('library').append(row);
  }
}

async function loadFile(meta) {
  showLoadbar(meta.kind === 'bios' ? 'Loading saved BIOS…' : 'Loading saved game…', 0, meta.name);
  try {
    const file = await getCachedFile(meta);
    await mountFile(file, meta.kind);
  } finally { hideLoadbar(); }
}

$('library-search').addEventListener('input', () => refreshLibrary().catch(report));

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
    savesWidget?.setActiveGame({ name: result.name, size: result.size, serial: result.name });
  }
  status(`${kind === 'bios' ? 'BIOS' : 'Game'} mounted. Header and end-of-file reads verified.`);
  return result;
}

async function importFile(file, kind) {
  if (!file || !ready || importing || downloading || launching || isRunning) return;
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
      showLoadbar('Saving to library…', 0, file.name);
      const meta = await cacheFile(file, kind, progress => {
        $('progress').value = progress;
        showLoadbar('Saving to library…', progress, file.name);
      }, importController.signal);
      await loadFile(meta);
    } else await mountFile(file, kind);
  } catch (error) {
    if (error.name === 'AbortError') status('Import canceled.');
    else throw error;
  } finally {
    importing = false;
    importController = null;
    $('progress').hidden = $('cancel').hidden = true;
    hideLoadbar();
    $('disc').disabled = $('bios').disabled = !ready;
    await refreshLibrary();
  }
}

async function loadAndRunGame(meta) {
  if (launching || importing || downloading || !ready || (!meta && (!hasGame || isRunning))) return;
  launching = true;
  $('btn-load-game').disabled = true;
  $('play').disabled = true;
  $('pause').disabled = true;
  $('stop').disabled = true;

  try {
    await refreshLibrary();
    if (meta) {
      if (isRunning) await stopGame();
      await loadFile(meta);
    }
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
    backend.send('bindings', { lines: keyboard.settingsLines() });
    const memcardFiles = await savesWidget?.getBootMemcardFiles();
    await backend.request('boot', { fastStart: true, mtvu: $('mtvu').checked, extraThreads: Number($('threads')?.value ?? 0), speed: speedTarget(), memcardFiles });
    if (waitingForVideo) showLoadbar('Starting game…', 0.88, 'Waiting for the first visible game frame. Interpreter startup can take several minutes.');

    $('empty').hidden = true;
    $('pause').disabled = false;
    $('stop').disabled = false;
    const btnSaveState = $('btn-save-state');
    if (btnSaveState) btnSaveState.disabled = false;
    $('fps').textContent = 'Starting…';
    isRunning = true;
    keyboard.session = true;
    keyboard.enabled = !isPaused;
    // Keep Enter/Space for the game rather than the focused toolbar button.
    $('screen').focus({ preventScroll: true });
    status(waitingForVideo ? 'Starting game — waiting for video.' : 'Game running.');
  } catch (err) {
    waitingForVideo = false;
    hideLoadbar();
    $('btn-load-game').disabled = !hasGame;
    $('play').disabled = !hasGame;
    $('pause').disabled = true;
    $('stop').disabled = true;
    report(err);
  } finally {
    launching = false;
    await refreshLibrary();
  }
}

async function pauseGame() {
  if (!isRunning) return;
  isPaused = !isPaused;
  keyboard.releaseAll();
  keyboard.enabled = !isPaused;
  await backend.request('pause', { paused: isPaused });
  $('pause').textContent = isPaused ? 'Resume' : 'Pause';
  if (isPaused) $('speed-actual').textContent = 'Paused';
  status(isPaused ? 'Emulation paused.' : 'Emulation resumed.');
}

async function stopGame() {
  if (!isRunning) return;
  waitingForVideo = false;
  hideLoadbar();
  keyboard.releaseAll();
  keyboard.session = keyboard.enabled = false;
  const btnSaveState = $('btn-save-state');
  if (btnSaveState) btnSaveState.disabled = true;
  const stopResult = await backend.request('stop');
  if (stopResult?.memcardFiles) {
    await savesWidget?.persistMemcard(stopResult.memcardFiles);
  }
  isRunning = false;
  isPaused = false;
  $('empty').hidden = false;
  $('play').disabled = !hasGame;
  $('btn-load-game').disabled = !hasGame;
  $('pause').disabled = true;
  $('pause').textContent = 'Pause';
  $('stop').disabled = true;
  $('fps').textContent = 'No game running';
  $('speed-actual').textContent = 'No game running';
  status('Emulation stopped.');
  await refreshLibrary();
}

function updateMetrics(metrics) {
  if (!metrics || metrics.length < 5) return;
  const fps = metrics[2];
  const speed = metrics[4];
  $('fps').textContent = `${fps.toFixed(1)} FPS · ${speed.toFixed(0)}% speed`;
  $('speed-actual').textContent = isPaused ? 'Paused' : `Measured: ${(speed / 100).toFixed(2)}×`;
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

for (const select of document.querySelectorAll('select')) select.addEventListener('change', () => { if (isRunning) $('screen').focus({ preventScroll: true }); });
keyboard.onPadKey = (name, pressed) => backend?.send('key', { name, pressed });
keyboard.onHotkey = (id, pressed) => {
  if (id === 'fastForward') { fastForward = pressed && isRunning; updateLimiter(); }
  else if (!pressed) return;
  else if (id === 'pause') pauseGame().catch(report);
  else if (id === 'fullscreen') $('fullscreen').click();
};
keyboard.onBindingsChanged = () => {
  renderKeyBindings();
  if (isRunning) backend.send('bindings', { lines: keyboard.settingsLines() });
};
keyboard.onCapture = id => {
  for (const button of document.querySelectorAll('#key-bindings button')) {
    const capturing = button.dataset.action === id;
    button.classList.toggle('capturing', capturing);
    button.textContent = capturing ? 'Press a key…' : keyLabel(keyboard.bindings[button.dataset.action]);
  }
};
function renderKeyBindings() {
  const list = $('key-bindings');
  const bindings = keyboard.bindings;
  list.replaceChildren(...actions.map(({ id, label, group }) => {
    const row = document.createElement('li');
    row.className = group;
    const name = document.createElement('span');
    name.textContent = label;
    const key = document.createElement('button');
    key.type = 'button';
    key.dataset.action = id;
    key.textContent = keyLabel(bindings[id]);
    key.setAttribute('aria-label', `${label}: ${keyLabel(bindings[id])}. Press to change.`);
    key.onclick = () => keyboard.capture(id);
    row.append(name, key);
    return row;
  }));
}
renderKeyBindings();
$('reset-keys').onclick = () => keyboard.reset();

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
  startInput(id => { $('gamepad').textContent = id ? `Gamepad detected (${id}). Gamepad play is not supported yet; use the keyboard.` : 'Gamepad play is not supported yet.'; });

  const canvas = $('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  backend = new Backend();
  // Frames finish at uneven wall-clock times while emulation runs below full speed. Keep a
  // short queue and present on display refresh at the average arrival interval, so motion
  // is evenly spaced; this costs at most about one frame of latency.
  const frames = [];
  let interval = 0, lastArrival = 0, lastPresent = 0;
  const present = ({ width, height, pixels }) => {
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
        updateLimiter();
        hideLoadbar();
        status('Game running.');
      }
    }
  };
  const tick = now => {
    // Present when the interval has elapsed, or immediately if the queue is backing up.
    if (frames.length && (now - lastPresent >= interval * 0.9 || frames.length > 2)) {
      lastPresent = now;
      present(frames.shift());
    }
    if (frames.length) requestAnimationFrame(tick);
  };
  backend.onFrame = frame => {
    const gap = frame.time - lastArrival;
    lastArrival = frame.time;
    // Ignore long gaps (pauses, loading) when estimating the steady frame interval.
    if (gap > 0 && gap < 250) interval = interval ? interval * 0.9 + gap * 0.1 : gap;
    if (frames.push(frame) > 3) frames.shift();
    if (frames.length === 1) requestAnimationFrame(tick);
    if (frame.metrics) updateMetrics(frame.metrics);
  };
  backend.onMetrics = ({ metrics }) => {
    if (metrics) updateMetrics(metrics);
  };

  const manifest = await backend.request('init');
  // A cached page talking to a newer worker (or the reverse) would drop controller bindings.
  if (manifest.workerProtocol !== WORKER_PROTOCOL) {
    if (!sessionStorage.getItem('pcsx2-protocol-reload')) {
      sessionStorage.setItem('pcsx2-protocol-reload', '1');
      location.reload();
      return;
    }
    throw new Error('The page and its emulator worker are different versions. Clear the site cache and reload.');
  }
  sessionStorage.removeItem('pcsx2-protocol-reload');
  ready = true;
  $('disc').disabled = $('bios').disabled = false;
  $('validate').disabled = false;
  $('core').textContent = `PCSX2 ${manifest.upstream.revision.slice(0,8)} · GS & VM Core`;
  $('availability').textContent = manifest.hasVM
    ? 'PCSX2 WebAssembly core is ready. Select a game to load & run.'
    : 'The graphics components are ready. PS2 game execution is still being ported.';
  status('Backend initialized. Ready to load PlayStation 2 games.');

  try {
    savesWidget = (await initSaves(backend, {
      onLaunchGame: async () => {
        if (!hasGame) {
          const games = (await listGames()).filter(g => g.kind === 'disc');
          const icoGame = games.find(g => g.name.toLowerCase().includes('ico') || g.name.includes('50760')) || games[0];
          if (icoGame) {
            await loadFile(icoGame);
          } else {
            $('disc').click();
            return;
          }
        }
        await loadAndRunGame();
      }
    })).widget;
  } catch (err) {
    report(err);
  }

  startArchive(async meta => { await loadFile(meta); await refreshLibrary(); }, () => importing || launching || isRunning, async active => { downloading = active; await refreshLibrary(); });
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
