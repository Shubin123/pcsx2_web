// SPDX-License-Identifier: GPL-3.0+
import { cacheStream } from './storage.js';
import { fetchArchiveDownload } from './archive-download.js';
export const ARCHIVE_ID = 'playstation-2-games-iso';
const base = `https://archive.org/download/${ARCHIVE_ID}/`;
export function catalogFiles(metadata) {
  if (!Array.isArray(metadata.files)) throw new Error('Archive returned an invalid file catalog.');
  return metadata.files.filter(file => /\.(iso|bin|elf)$/i.test(file.name) && !file.private && Number(file.size) > 0)
    .map(file => ({ name: file.name, size: Number(file.size), region: ['USA', 'Europe', 'Japan'].find(region => file.name.includes(`(${region})`)) || 'other', url: base + file.name.split('/').map(encodeURIComponent).join('/') }));
}
export function startArchive(onReady, busy, onBusy = async () => {}) {
  const $ = id => document.getElementById(id);
  let games = [], page = 0, controller, loading = false;
  function render() {
    let filtered = games.filter(game => game.name.toLowerCase().includes($('archive-search').value.toLowerCase()) && ($('archive-region').value === 'all' || game.region === $('archive-region').value));
    filtered.sort($('archive-sort').value === 'size' ? (a,b) => a.size-b.size : (a,b) => a.name.localeCompare(b.name));
    const pages = Math.max(1, Math.ceil(filtered.length / 20)); page = Math.min(page, pages - 1);
    $('archive-page').textContent = `${filtered.length} games · Page ${page+1} of ${pages}`;
    $('archive-prev').disabled = page === 0; $('archive-next').disabled = page >= pages-1;
    $('archive-list').replaceChildren(...filtered.slice(page*20, page*20+20).map(game => {
      const row = document.createElement('li'), title = document.createElement('span'), size = document.createElement('small'), button = document.createElement('button');
      const link = document.createElement('a'); link.textContent = game.name; link.href = game.url; link.target = '_blank'; link.rel = 'noopener'; link.title = 'Open direct download (then import the downloaded file)'; title.append(link); size.textContent = `${(game.size/1073741824).toFixed(2)} GiB · ${game.region}`; title.append(size);
      button.textContent = 'Download & cache'; button.disabled = !!controller;
      button.onclick = () => download(game); row.append(title, button); return row;
    }));
  }
  async function refresh() {
    if (loading) return; loading = true; $('archive-refresh').disabled = true;
    $('archive-status').textContent = 'Fetching Internet Archive catalog…';
    try {
      const response = await fetch(`https://archive.org/metadata/${ARCHIVE_ID}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
      games = catalogFiles(await response.json()); render();
      $('archive-status').textContent = `${games.length} disc images available. Downloads are cached here; game execution is still being ported.`;
    } catch(error) { $('archive-status').textContent = `Could not load catalog: ${error.message}. Open the archive link or retry.`; }
    finally { loading = false; $('archive-refresh').disabled = false; }
  }
  async function download(game) {
    if (controller || busy()) return;
    controller = new AbortController(); const signal = controller.signal;
    $('archive-progress').hidden = $('archive-cancel').hidden = false; $('archive-progress').value = 0; render();
    // Prevent local mounts from racing with a download and replay.
    const inputs = [$('disc'), $('bios')]; inputs.forEach(input => { input.disabled = true; });
    const start = performance.now();
    try {
      await onBusy(true);
      const { usage = 0, quota } = await navigator.storage.estimate();
      if (quota && game.size > quota - usage) throw new Error('Not enough browser storage. Remove cached games first.');
      $('archive-status').textContent = `Connecting: ${game.name}`;
      const response = await fetchArchiveDownload(game, signal);
      if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}. The archive may require sign-in or be unavailable.`);
      const meta = await cacheStream(response.body, game.name, game.size, 'disc', progress => {
        $('archive-progress').value = progress;
        const elapsed = Math.max(1, (performance.now()-start)/1000);
        $('archive-status').textContent = `${game.name} · ${(progress*100).toFixed(1)}% · ${(progress*game.size/1048576/elapsed).toFixed(1)} MiB/s`;
      }, signal);
      await onReady(meta); $('archive-status').textContent = `${game.name} cached and mounted.`;
    } catch(error) { $('archive-status').textContent = error.name === 'AbortError' ? 'Download canceled; partial cache removed.' : `${error.message} Open the game title link to download directly, then choose the local file.`; }
    finally { controller = null; await onBusy(false); inputs.forEach(input => { input.disabled = false; }); $('archive-progress').hidden = $('archive-cancel').hidden = true; render(); }
  }
  $('archive-cancel').onclick = () => controller?.abort();
  for (const id of ['archive-search','archive-region','archive-sort']) $(id).addEventListener('input', () => { page=0; render(); });
  $('archive-refresh').onclick = refresh;
  $('archive-prev').onclick = () => { page--; render(); };
  $('archive-next').onclick = () => { page++; render(); };
  refresh();
}
