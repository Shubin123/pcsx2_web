// SPDX-License-Identifier: GPL-3.0+
// Blocking file reads belong here, never on the browser UI thread.
if (globalThis.name === 'em-pthread') {
  importScripts('./runtime/pcsx2-vm.js');
} else {
  let module;
  let vmModule;
  let manifest;
  const mounts = new Map();
  const mountedBlobs = new Map();
  let running = false;
  let frameTimer = null;
  let frameInfoPtr = 0;
  let frameBufferPtr = 0;
  let metricsPtr = 0;
  const WORKER_PROTOCOL = 2; // Must match app.js.
  let vmCompile = null;
  let pendingSettings = '';

  const runtimeUrl = name => new URL(`./runtime/${name}?v=${manifest.files[name]?.sha256 || manifest.backendRevision}`, self.location).href;

  // Download and compile the VM while the user picks a game, so Play only instantiates it.
  // Instantiating early would reserve the VM's 1 GiB heap and spawn its threads; compiling
  // does neither. The browser also caches the compiled code for later visits.
  function compileVM() {
    if (!manifest?.hasVM) return null;
    vmCompile ??= (async () => {
      importScripts(runtimeUrl('pcsx2-vm.js'));
      const response = fetch(runtimeUrl('pcsx2-vm.wasm'), { credentials: 'same-origin' });
      try { return await WebAssembly.compileStreaming(response); }
      catch { return WebAssembly.compile(await (await response).arrayBuffer()); } // Wrong MIME type
    })();
    vmCompile.catch(() => { vmCompile = null; });
    return vmCompile;
  }

  async function initialize() {
    const response = await fetch('./runtime/manifest.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('Backend artifacts are missing. Run npm run sync.');
    manifest = await response.json();
    if (manifest.schema !== 1 || manifest.abi !== 1 || manifest.kind !== 'portability-components' || manifest.entry !== 'pcsx2-port.js') {
      throw new Error('Unsupported backend manifest');
    }
    // Versioned JS and Wasm are published together; avoid old browser caches.
    importScripts(`./runtime/pcsx2-port.js?v=${manifest.files['pcsx2-port.js'].sha256}`);
    module = await self.createPCSX2Port({
      locateFile: name => new URL(`./runtime/${name}?v=${manifest.files[name]?.sha256 || manifest.backendRevision}`, self.location).href
    });
    if (module._pcsx2_port_abi() !== manifest.abi || Boolean(module._pcsx2_port_capabilities() & 2) !== manifest.emulation) {
      throw new Error('Backend ABI or capability mismatch');
    }
    compileVM()?.catch(() => {}); // Boot reports a failure; preloading is best effort.
    return { ...manifest, workerProtocol: WORKER_PROTOCOL };
  }

  async function mount({ file, kind }) {
    if (!module) throw new Error('Backend not initialized');
    if (!['disc', 'bios'].includes(kind)) throw new Error('Unknown file kind');
    mountedBlobs.set(kind, file);
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

  function startVMLoop() {
    if (frameTimer) clearInterval(frameTimer);
    if (!frameInfoPtr) frameInfoPtr = vmModule._malloc(12);
    if (!frameBufferPtr) frameBufferPtr = vmModule._malloc(1024 * 1024 * 4);
    if (!metricsPtr) metricsPtr = vmModule._malloc(8 * 6);

    // Read metadata first; unchanged frames need no 1.2 MiB Wasm copy or transfer.
    vmModule._pcsx2_vm_frame(0, 0, frameInfoPtr);
    let lastSequence = vmModule.HEAPU32[frameInfoPtr / 4 + 2];
    // Poll finely: frame arrival times feed the page's pacing, and a coarse timer would
    // quantise them. Metadata reads are cheap; pixels are copied only for new frames.
    let lastMetrics = 0;
    frameTimer = setInterval(() => {
      if (!running || !vmModule) return;
      const state = vmModule._pcsx2_vm_state();
      if (state === 0) return;

      vmModule._pcsx2_vm_frame(0, 0, frameInfoPtr);
      const sequence = vmModule.HEAPU32[frameInfoPtr / 4 + 2];
      const now = performance.now();
      const copied = sequence !== lastSequence && vmModule._pcsx2_vm_frame(frameBufferPtr, 1024 * 1024 * 4, frameInfoPtr);
      if (!copied && now - lastMetrics < 250) return;
      lastMetrics = now;
      vmModule._pcsx2_vm_metrics(metricsPtr);
      const metrics = Array.from({ length: 6 }, (_, i) => vmModule.HEAPF64[metricsPtr / 8 + i]);
      if (copied) {
        const width = vmModule.HEAPU32[frameInfoPtr / 4];
        const height = vmModule.HEAPU32[frameInfoPtr / 4 + 1];
        const seq = vmModule.HEAPU32[frameInfoPtr / 4 + 2];
        if (width > 0 && height > 0) {
          lastSequence = seq;
          const pixels = new Uint8ClampedArray(vmModule.HEAPU8.buffer, frameBufferPtr, width * height * 4);
          const copy = new Uint8ClampedArray(pixels);
          self.postMessage({ type: 'frame', width, height, seq, time: now, pixels: copy.buffer, metrics }, [copy.buffer]);
          return;
        }
      }
      self.postMessage({ type: 'metrics', metrics });
    }, 4);
  }

  function applySettings(lines) {
    const ptr = vmModule.stringToNewUTF8(lines);
    vmModule._pcsx2_vm_set_settings(ptr);
    vmModule._free(ptr);
  }

  /** Controller bindings: applied now if the VM exists, otherwise at boot. */
  function setBindings(lines) {
    if (vmModule) applySettings(lines);
    else pendingSettings = lines;
  }

  async function boot(data) {
    if (typeof WebAssembly.Exception !== 'function' || typeof WebAssembly.Tag !== 'function') {
      throw new Error('This browser cannot run the current emulator. Please update your browser.');
    }
    if (!manifest?.hasVM) throw new Error('VM binary not available in manifest');
    const biosFile = mountedBlobs.get('bios');
    const discFile = mountedBlobs.get('disc');
    if (!biosFile) throw new Error('BIOS is not mounted');
    if (!discFile) throw new Error('Game disc is not mounted');

    if (!vmModule) {
      const compiled = await compileVM();
      vmModule = await self.createPCSX2VM({
        locateFile: runtimeUrl,
        instantiateWasm(imports, receive) {
          WebAssembly.instantiate(compiled, imports).then(instance => receive(instance, compiled));
          return {};
        }
      });
    }

    try { vmModule.FS.mkdir('/bios'); } catch (_) {}
    try { vmModule.FS.mkdir('/disc'); } catch (_) {}
    try { vmModule.FS.unmount('/bios'); } catch (_) {}
    try { vmModule.FS.unmount('/disc'); } catch (_) {}

    vmModule.FS.mount(vmModule.WORKERFS, { blobs: [{ name: 'image', data: biosFile }] }, '/bios');
    vmModule.FS.mount(vmModule.WORKERFS, { blobs: [{ name: 'image', data: discFile }] }, '/disc');

    if (vmModule._pcsx2_vm_init() !== 1) {
      throw new Error('Failed to initialize PCSX2 CPU thread');
    }
    vmModule._pcsx2_vm_set_surface(640, 480);

    // One batch, so the core applies settings once rather than per key.
    applySettings([
      ['EmuCore/Speedhacks', 'fastCDVD', 'true'],
      ['EmuCore/Speedhacks', 'EECycleSkip', '2'],
      ['EmuCore/Speedhacks', 'EECycleRate', '-2'],
      ['EmuCore/Speedhacks', 'IntcStat', 'true'],
      ['EmuCore/Speedhacks', 'WaitLoop', 'true'],
      ['EmuCore/Speedhacks', 'vu1Instant', 'true'],
      ['EmuCore/GS', 'extrathreads', '0']
    ].map(entry => entry.join('\t')).join('\n') + (pendingSettings ? `\n${pendingSettings}` : ''));
    pendingSettings = '';
    // Startup shows black frames while the game loads; run it unthrottled until the page
    // sees a picture. Throttling only maps guest time to wall time.
    vmModule._pcsx2_vm_set_limiter(data?.fastStart ? 3 : 0);

    const pathPtr = vmModule.stringToNewUTF8('/disc/image');
    const bootOk = vmModule._pcsx2_vm_boot(pathPtr);
    vmModule._free(pathPtr);
    if (!bootOk) throw new Error('pcsx2_vm_boot rejected boot request');

    running = true;
    startVMLoop();
    return { success: true };
  }

  function pause(paused) {
    if (vmModule) vmModule._pcsx2_vm_set_paused(paused ? 1 : 0);
  }

  function stop() {
    running = false;
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
    if (vmModule) vmModule._pcsx2_vm_stop();
  }

  /** Controller 1 inputs as the emulated DualShock 2 holds them (PadDualshock2 order). */
  function padState() {
    if (!vmModule) return null;
    const ptr = vmModule._malloc(64);
    try {
      const count = vmModule._pcsx2_vm_pad_inputs(ptr, 64);
      return Array.from(vmModule.HEAPU8.subarray(ptr, ptr + Math.min(count, 64)));
    } finally { vmModule._free(ptr); }
  }

  function sendKey(name, pressed) {
    if (!vmModule) return;
    const ptr = vmModule.stringToNewUTF8(name);
    vmModule._pcsx2_vm_key(ptr, pressed ? 1 : 0);
    vmModule._free(ptr);
  }

  // Serial dispatch prevents overlapping mounts and module initialization.
  let pending = Promise.resolve();
  self.onmessage = event => {
    if (event.data.action === 'key') {
      sendKey(event.data.data.name, event.data.data.pressed);
      return;
    }
    if (event.data.action === 'limiter') {
      vmModule?._pcsx2_vm_set_limiter(event.data.data.mode);
      return;
    }
    if (event.data.action === 'bindings') {
      // Before boot this only records the lines; keep it ordered with boot via the queue.
      pending = pending.then(() => { try { setBindings(event.data.data.lines); } catch (error) { console.error(error); } });
      return;
    }
    pending = pending.then(async () => {
      const { id, action, data } = event.data;
      try {
        let result;
        if (action === 'init') result = await initialize();
        else if (action === 'mount') result = await mount(data);
        else if (action === 'validate') result = validate();
        else if (action === 'boot') result = await boot(data);
        else if (action === 'pause') { pause(data.paused); result = { paused: data.paused }; }
        else if (action === 'stop') { stop(); result = { stopped: true }; }
        else if (action === 'padState') result = padState();
        else throw new Error(`Unsupported action: ${action}`);
        self.postMessage({ id, result });
      } catch (error) { self.postMessage({ id, error: error.message }); }
    });
  };
}
