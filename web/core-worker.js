// SPDX-License-Identifier: GPL-3.0+
// Blocking file reads belong here, never on the browser UI thread.
let module;
let manifest;
const mounts = new Map();
async function initialize() {
  const response = await fetch('./runtime/manifest.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('Backend artifacts are missing. Run npm run sync.');
  manifest = await response.json();
  if (manifest.schema !== 1 || manifest.abi !== 1 || manifest.kind !== 'portability-components' || manifest.entry !== 'pcsx2-port.js') throw new Error('Unsupported backend manifest');
  // Versioned JS and Wasm are published together; avoid old browser caches.
  importScripts(`./runtime/pcsx2-port.js?v=${manifest.files['pcsx2-port.js'].sha256}`);
  module = await self.createPCSX2Port({ locateFile: name => new URL(`./runtime/${name}?v=${manifest.files[name]?.sha256 || manifest.backendRevision}`, self.location).href });
  if (module._pcsx2_port_abi() !== manifest.abi || Boolean(module._pcsx2_port_capabilities() & 2) !== manifest.emulation) throw new Error('Backend ABI or capability mismatch');
  return manifest;
}
async function mount({ file, kind }) {
  if (!module) throw new Error('Backend not initialized');
  if (!['disc', 'bios'].includes(kind)) throw new Error('Unknown file kind');
  const directory = `/${kind}`;
  if (mounts.has(kind)) { module.FS.unmount(directory); mounts.delete(kind); }
  if (!module.FS.analyzePath(directory).exists) module.FS.mkdir(directory);
  module.FS.mount(module.WORKERFS, { blobs: [{ name: 'image', data: file }] }, directory);
  mounts.set(kind, directory);
  const stream = module.FS.open(`${directory}/image`, 'r');
  try {
    const header = new Uint8Array(Math.min(64, file.size));
    const tail = new Uint8Array(Math.min(16, file.size));
    const headCount = module.FS.read(stream, header, 0, header.length, 0);
    const tailCount = module.FS.read(stream, tail, 0, tail.length, file.size - tail.length);
    if (headCount !== header.length || tailCount !== tail.length) throw new Error('Incomplete file read');
    return { kind, name: file.name, size: file.size, header: [...header], tail: [...tail], path: `${directory}/image` };
  } finally { module.FS.close(stream); }
}
function validate() {
  if (!module) throw new Error('Backend not initialized');
  const pointers = Array.from({ length: 3 }, () => module._malloc(256));
  if (pointers.some(pointer => !pointer)) { pointers.forEach(pointer => module._free(pointer)); throw new Error('Allocation failed'); }
  const [input, tiled, output] = pointers;
  const values = Uint32Array.from({ length: 64 }, (_, i) => (Math.imul(i + 1, 0x1020304) ^ 0xaabbccdd) >>> 0);
  try {
    module.HEAPU32.set(values, input >>> 2);
    module._pcsx2_gs_write32(tiled, input);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const offset = module._pcsx2_gs_offset32(x, y);
      if (offset >= 64 || module.HEAPU32[(tiled >>> 2) + offset] !== values[y * 8 + x]) throw new Error(`GS pixel mismatch at ${x},${y}`);
    }
    module._pcsx2_gs_read32(tiled, output);
    for (let i = 0; i < 64; i++) if (module.HEAPU32[(output >>> 2) + i] !== values[i]) throw new Error(`GS round-trip mismatch at ${i}`);
    return { pixels: 64, passed: true, revision: module.UTF8ToString(module._pcsx2_port_revision()) };
  } finally { pointers.forEach(pointer => module._free(pointer)); }
}
// Serial dispatch prevents overlapping mounts and module initialization.
let pending = Promise.resolve();
self.onmessage = event => {
  pending = pending.then(async () => {
    const { id, action, data } = event.data;
    try {
      let result;
      if (action === 'init') result = await initialize();
      else if (action === 'mount') result = await mount(data);
      else if (action === 'validate') result = validate();
      else throw new Error(`Unsupported action: ${action}`);
      self.postMessage({ id, result });
    } catch (error) { self.postMessage({ id, error: error.message }); }
  });
};
