// SPDX-License-Identifier: GPL-3.0+
const $ = id => document.getElementById(id);
const defaults = { aspect: '4:3', filter: 'pixelated', cache: true, mtvu: true, threads: '2' };
let settings = { ...defaults };
try { const saved = JSON.parse(localStorage.getItem('pcsx2-preferences')); for (const key of Object.keys(defaults)) if (saved && typeof saved[key] === typeof defaults[key]) settings[key] = saved[key]; } catch {}
function apply() {
  // PS2 output is 4:3 (or anamorphic 16:9) whatever its framebuffer size; 'native' was 640x448.
  if (!['4:3', '16:9'].includes(settings.aspect)) settings.aspect = '4:3';
  if (!['pixelated', 'auto'].includes(settings.filter)) settings.filter = 'pixelated';
  if (!['0', '1', '2', '3'].includes(settings.threads)) settings.threads = '2';
  $('aspect').value = settings.aspect; $('filter').value = settings.filter; $('cache').checked = settings.cache; $('mtvu').checked = settings.mtvu;
  if ($('threads')) $('threads').value = settings.threads;
  $('screen').style.setProperty('--screen-aspect', settings.aspect.replace(':', '/'));
  $('canvas').style.imageRendering = settings.filter;
}
for (const key of Object.keys(defaults)) $(key).addEventListener('change', () => {
  settings[key] = typeof defaults[key] === 'boolean' ? $(key).checked : $(key).value;
  try { localStorage.setItem('pcsx2-preferences', JSON.stringify(settings)); } catch {}
  apply();
});
$('reset-settings').onclick = () => { settings = { ...defaults }; try { localStorage.removeItem('pcsx2-preferences'); } catch {} apply(); window.PCSX2Layout?.reset(); };
$('clear-log').onclick = () => { $('log').textContent = ''; };
$('screenshot').onclick = () => $('canvas').toBlob(blob => {
  if (!blob) return;
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `pcsx2-${Date.now()}.png`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('keydown', event => { if (event.altKey && event.key === 'Enter') { event.preventDefault(); $('fullscreen').click(); } });
async function storageInfo() {
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const persistent = await navigator.storage.persisted();
    $('storage-info').textContent = `${(usage / 1073741824).toFixed(2)} GiB used of ${(quota / 1073741824).toFixed(2)} GiB · ${persistent ? 'Persistent' : 'Best effort'}`;
  } catch { $('storage-info').textContent = 'Browser storage information unavailable.'; }
}
$('persist').onclick = async () => { try { await navigator.storage.persist(); await storageInfo(); } catch (e) { $('storage-info').textContent = e.message; } };
apply(); storageInfo();
setInterval(storageInfo, 10000);
