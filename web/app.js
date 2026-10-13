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
const status = message => {
  $('status').textContent = message;
  const log = $('log');
  log.textContent = (log.textContent + `${new Date().toLocaleTimeString()} ${message}\n`).split('\n').slice(-150).join('\n');
};
const report = error => status(error.message || String(error));
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
  $(kind === 'bios' ? 'bios-name' : 'selected').textContent = `${result.name} · ${(result.size / 1048576).toFixed(1)} MiB`;
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
$('disc').onchange = event => { const file = event.target.files[0]; event.target.value = ''; importFile(file, 'disc').catch(report); };
$('bios').onchange = event => { const file = event.target.files[0]; event.target.value = ''; importFile(file, 'bios').catch(report); };
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
  backend = new Backend();
  const manifest = await backend.request('init');
  ready = true;
  $('disc').disabled = $('bios').disabled = false;
  $('validate').disabled = false;
  $('core').textContent = `PCSX2 ${manifest.upstream.revision.slice(0,8)} · GS components`;
  $('availability').textContent = 'The graphics components are ready. PS2 game execution is still being ported.';
  status('You can cache and mount files, and validate the upstream GS kernels. Play is unavailable until the emulator core is connected.');
  startArchive(async meta => { await loadFile(meta); await refreshLibrary(); }, () => importing, async active => { downloading = active; await refreshLibrary(); });
  await refreshLibrary();
  const bios = (await listGames()).find(entry => entry.kind === 'bios');
  if (bios) await loadFile(bios);
}
initialize().catch(error => { $('core').textContent = 'Unavailable'; $('availability').textContent = 'The backend could not start.'; report(error); });
