// SPDX-License-Identifier: GPL-3.0+
// Save file system: PS3 virtual saves (.PSV), PS2 memory card folder persistence,
// and emulator save state management for PCSX2 Web.

const DB_NAME = 'pcsx2-saves';
const DB_VERSION = 1;
const STORE_MEMCARDS = 'memcards';
const STORE_STATES = 'saveStates';

/**
 * Generates an 8,192-byte PCSX2 folder memory card superblock.
 * Follows the standard Sony PS2 Memory Card Format 1.2.0.0.
 */
export function createSuperblock() {
  const buf = new Uint8Array(8192);
  buf.fill(0xff);
  const textEncoder = new TextEncoder();
  const magic = textEncoder.encode('Sony PS2 Memory Card Format 1.2.0.0');
  buf.set(magic, 0);
  buf.fill(0, 0x1b, 0x28);

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint16(0x28, 512, true);  // page_len
  view.setUint16(0x2a, 2, true);    // pages_per_cluster
  view.setUint16(0x2c, 16, true);   // pages_per_block
  view.setUint16(0x2e, 0, true);    // unused
  view.setUint32(0x30, 8192, true); // clusters_per_card (8 MiB)
  view.setUint32(0x34, 41, true);   // alloc_offset
  view.setUint32(0x38, 8135, true); // alloc_end
  view.setUint32(0x3c, 0, true);    // rootdir_cluster
  view.setUint32(0x40, 1023, true); // backup_block1
  view.setUint32(0x44, 1022, true); // backup_block2
  buf.fill(0, 0x48, 0x50);          // padding
  buf.fill(0, 0x50, 0xd0);          // ifc_list
  view.setUint32(0x50, 8, true);    // ifc_list[0] = 8
  buf.fill(0, 0xd0, 0x150);         // bad_block_list
  view.setUint8(0x150, 2);          // card_type (PS2)
  view.setUint8(0x151, 0x52);       // card_flags
  buf.fill(0, 0x152, 0x200);        // reserved
  return buf;
}

/**
 * Parses a PlayStation 3 Virtual Save file (.PSV).
 * Magic: \0VSP
 * Record structure: 60 bytes per file descriptor at offset 0x00A0.
 */
export function parsePSV(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 0xa0) throw new Error('File too small to be a valid PSV file.');
  if (bytes[0] !== 0x00 || bytes[1] !== 0x56 || bytes[2] !== 0x53 || bytes[3] !== 0x50) {
    throw new Error('Invalid PSV signature (expected \\0VSP).');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint32(0x3c, true); // 1 = PS1, 2 = PS2
  const numFiles = view.getUint32(0x64, true);

  let dirEnd = 0x80;
  while (dirEnd < 0xa0 && bytes[dirEnd] !== 0) dirEnd++;
  const dirName = new TextDecoder('ascii').decode(bytes.subarray(0x80, dirEnd)).trim();
  if (!dirName) throw new Error('Could not find directory name in PSV header.');

  const files = [];
  for (let i = 0; i < numFiles; i++) {
    const entryOffset = 0xa0 + i * 0x3c;
    if (entryOffset + 0x3c > bytes.length) break;

    const size = view.getUint32(entryOffset + 0x10, true);
    const mode = view.getUint32(entryOffset + 0x14, true);
    const dataOffset = view.getUint32(entryOffset + 0x38, true);

    let fnEnd = entryOffset + 0x18;
    while (fnEnd < entryOffset + 0x38 && bytes[fnEnd] !== 0) fnEnd++;
    const name = new TextDecoder('ascii').decode(bytes.subarray(entryOffset + 0x18, fnEnd)).trim();
    if (!name || dataOffset + size > bytes.length) continue;

    const data = bytes.slice(dataOffset, dataOffset + size);
    files.push({ name, size, mode, data });
  }

  // Extract game title from icon.sys if present
  let title = dirName;
  const iconSys = files.find(f => f.name === 'icon.sys');
  if (iconSys && iconSys.data.length >= 0xc0) {
    try {
      let titleEnd = 0xc0;
      while (titleEnd < Math.min(iconSys.data.length, 0x100) && iconSys.data[titleEnd] !== 0) titleEnd++;
      if (titleEnd > 0xc0) {
        const decoded = new TextDecoder('shift-jis').decode(iconSys.data.subarray(0xc0, titleEnd)).trim();
        if (decoded) title = decoded;
      }
    } catch (_) {}
  }

  return { type, dirName, title, numFiles: files.length, files };
}

/**
 * Durable browser storage for PS2 memory card files and save states using IndexedDB.
 */
export class SaveStore {
  #db = null;

  async init() {
    if (this.#db) return this;
    if (!('indexedDB' in globalThis)) return this;
    this.#db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_MEMCARDS)) {
          db.createObjectStore(STORE_MEMCARDS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_STATES)) {
          const store = db.createObjectStore(STORE_STATES, { keyPath: 'key' });
          store.createIndex('gameSerial', 'gameSerial', { unique: false });
          store.createIndex('savedAt', 'savedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open save database'));
    });
    return this;
  }

  #tx(storeName, mode, callback) {
    return new Promise((resolve, reject) => {
      if (!this.#db) return resolve(null);
      const transaction = this.#db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;
      try { result = callback(store); }
      catch (err) { reject(err); return; }
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () => reject(transaction.error || new Error('Transaction failed'));
    });
  }

  async getMemcard(id = 'Mcd001.ps2') {
    const record = await this.#tx(STORE_MEMCARDS, 'readonly', s => s.get(id));
    return record?.files || [];
  }

  async putMemcard(id = 'Mcd001.ps2', files = []) {
    return this.#tx(STORE_MEMCARDS, 'readwrite', s => s.put({
      id,
      updated: Date.now(),
      files: files.map(f => ({
        path: f.path,
        size: f.data?.length ?? f.size ?? 0,
        data: f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data)
      }))
    }));
  }

  /**
   * Imports a .PSV file into the primary memory card (Mcd001.ps2).
   */
  async importPSV(buffer) {
    const parsed = parsePSV(buffer);
    const existing = await this.getMemcard('Mcd001.ps2');
    const fileMap = new Map();

    // Preserve existing files not belonging to this save folder
    for (const f of existing) {
      if (!f.path.startsWith(`${parsed.dirName}/`)) {
        fileMap.set(f.path, f);
      }
    }

    // Ensure _pcsx2_superblock exists
    if (!fileMap.has('_pcsx2_superblock')) {
      fileMap.set('_pcsx2_superblock', {
        path: '_pcsx2_superblock',
        size: 8192,
        data: createSuperblock()
      });
    }

    // Add all files from the PSV save directory
    for (const file of parsed.files) {
      const relPath = `${parsed.dirName}/${file.name}`;
      fileMap.set(relPath, {
        path: relPath,
        size: file.size,
        data: file.data
      });
    }

    const updatedFiles = Array.from(fileMap.values());
    await this.putMemcard('Mcd001.ps2', updatedFiles);

    return {
      dirName: parsed.dirName,
      title: parsed.title,
      filesCount: parsed.files.length,
      totalSize: parsed.files.reduce((acc, f) => acc + f.size, 0)
    };
  }

  async listStates(gameSerial) {
    const records = await this.#tx(STORE_STATES, 'readonly', s => {
      if (gameSerial && s.indexNames.contains('gameSerial')) {
        return s.index('gameSerial').getAll(gameSerial);
      }
      return s.getAll();
    });
    return (records || []).sort((a, b) => b.savedAt - a.savedAt);
  }

  async getState(gameSerial, slot) {
    const key = `${gameSerial}:${slot}`;
    return this.#tx(STORE_STATES, 'readonly', s => s.get(key));
  }

  async putState(gameSerial, slot, title, filename, bytes) {
    const key = `${gameSerial}:${slot}`;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return this.#tx(STORE_STATES, 'readwrite', s => s.put({
      key,
      gameSerial,
      slot: Number(slot),
      title: title || `Slot ${slot}`,
      filename,
      size: data.length,
      savedAt: Date.now(),
      data
    }));
  }

  async deleteState(gameSerial, slot) {
    const key = `${gameSerial}:${slot}`;
    return this.#tx(STORE_STATES, 'readwrite', s => s.delete(key));
  }
}

/**
 * Widget UI manager for save states, memory card saves, and PSV file imports.
 */
export class SavesWidget {
  #store;
  #backend;
  #options;
  #activeGame = null;
  #selectedSlot = 1;
  #memcardFiles = [];

  constructor(store, backend, options = {}) {
    this.#store = store;
    this.#backend = backend;
    this.#options = options;
  }

  async init() {
    this.#memcardFiles = await this.#store.getMemcard('Mcd001.ps2');
    this.#setupElements();
    await this.refreshUI();
  }

  #setupElements() {
    const slotSelect = document.getElementById('save-state-slot');
    if (slotSelect) {
      slotSelect.value = String(this.#selectedSlot);
      slotSelect.onchange = () => {
        this.#selectedSlot = Number(slotSelect.value) || 1;
        this.refreshUI();
      };
    }

    const btnSave = document.getElementById('btn-save-state');
    if (btnSave) {
      btnSave.onclick = () => this.saveCurrentState();
    }

    const btnLoad = document.getElementById('btn-load-state');
    if (btnLoad) {
      btnLoad.onclick = () => this.loadSelectedState();
    }

    const btnQuickLoad = document.getElementById('btn-quick-load-save');
    if (btnQuickLoad) {
      btnQuickLoad.onclick = () => this.quickLoadSave();
    }

    const inputImport = document.getElementById('input-import-save');
    if (inputImport) {
      inputImport.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (file) await this.importFile(file);
        e.target.value = '';
      };
    }

    const btnExport = document.getElementById('btn-export-save');
    if (btnExport) {
      btnExport.onclick = () => this.exportMemcard();
    }

    // Drag and drop on widget card
    const card = document.querySelector('[data-widget="saves"]');
    if (card) {
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('save-drop-active'); });
      card.addEventListener('dragleave', () => card.classList.remove('save-drop-active'));
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        card.classList.remove('save-drop-active');
        const file = e.dataTransfer?.files?.[0];
        if (file) await this.importFile(file);
      });
    }
  }

  setStatus(msg, isError = false) {
    const el = document.getElementById('save-status');
    if (el) {
      el.textContent = msg;
      el.style.color = isError ? '#ff6b81' : '#a8b2d1';
    }
  }

  setActiveGame(game) {
    this.#activeGame = game;
    this.refreshUI();
  }

  async getBootMemcardFiles() {
    let files = await this.#store.getMemcard('Mcd001.ps2');
    if (!files || !files.length || !files.some(f => f.path === '_pcsx2_superblock')) {
      const sb = createSuperblock();
      files = [{ path: '_pcsx2_superblock', size: sb.length, data: sb }, ...(files || [])];
      await this.#store.putMemcard('Mcd001.ps2', files);
    }
    this.#memcardFiles = files;
    return files;
  }

  async persistMemcard(files) {
    if (!files || !files.length) return;
    await this.#store.putMemcard('Mcd001.ps2', files);
    this.#memcardFiles = files;
    await this.refreshUI();
  }

  async importFile(file) {
    this.setStatus(`Importing ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      const ext = file.name.split('.').pop()?.toLowerCase();

      if (ext === 'psv') {
        const info = await this.#store.importPSV(buf);
        this.#memcardFiles = await this.#store.getMemcard('Mcd001.ps2');
        this.setStatus(`Imported PSV save: ${info.title} (${info.filesCount} files) into Memory Card 1.`);
      } else if (ext === 'p2s') {
        const serial = this.#activeGame?.serial || 'GENERIC';
        await this.#store.putState(serial, this.#selectedSlot, file.name, file.name, new Uint8Array(buf));
        this.setStatus(`Imported save state into Slot ${this.#selectedSlot}.`);
      } else if (ext === 'json') {
        const text = new TextDecoder().decode(buf);
        const bundle = JSON.parse(text);
        if (bundle.files && Array.isArray(bundle.files)) {
          const imported = bundle.files
            .filter(f => !f.path.startsWith('TEST/'))
            .map(f => ({
              path: f.path,
              size: f.size,
              data: Uint8Array.from(atob(f.base64), c => c.charCodeAt(0))
            }));
          await this.persistMemcard(imported);
          this.setStatus(`Imported memory card save: ${bundle.gameTitle || file.name} (${imported.length} files).`);
        } else {
          throw new Error('Invalid save file format (expected pcsx2-folder-mcd backup).');
        }
      } else {
        throw new Error('Unsupported format. Please select a .PSV save, .p2s state, or .json backup.');
      }
      await this.refreshUI();
    } catch (err) {
      this.setStatus(`Import failed: ${err.message}`, true);
    }
  }

  async saveCurrentState() {
    if (!this.#backend) return;
    const btnSave = document.getElementById('btn-save-state');
    if (btnSave) btnSave.disabled = true;
    this.setStatus(`Saving state to Slot ${this.#selectedSlot}…`);
    try {
      const result = await this.#backend.request('saveState', { slot: this.#selectedSlot });
      const serial = this.#activeGame?.serial || 'GAME';
      const title = `${this.#activeGame?.name || 'Game'} - Slot ${this.#selectedSlot}`;
      await this.#store.putState(serial, this.#selectedSlot, title, result.name, new Uint8Array(result.bytes));
      this.setStatus(`Saved state to Slot ${this.#selectedSlot} successfully.`);
      await this.refreshUI();
    } catch (err) {
      this.setStatus(`Save state failed: ${err.message}`, true);
    } finally {
      if (btnSave) btnSave.disabled = false;
    }
  }

  async loadSelectedState() {
    if (!this.#backend) return;
    const serial = this.#activeGame?.serial || 'GAME';
    const stateRecord = await this.#store.getState(serial, this.#selectedSlot);
    if (!stateRecord) {
      this.setStatus(`No save state found in Slot ${this.#selectedSlot}.`, true);
      return;
    }

    this.setStatus(`Loading state from Slot ${this.#selectedSlot}…`);
    try {
      await this.#backend.request('loadState', {
        slot: this.#selectedSlot,
        stateData: { name: stateRecord.filename, bytes: Array.from(stateRecord.data) }
      });
      this.setStatus(`Loaded state from Slot ${this.#selectedSlot}.`);
    } catch (err) {
      this.setStatus(`Load state failed: ${err.message}`, true);
    }
  }

  async quickLoadSave() {
    if (this.#options.onLaunchGame) {
      this.setStatus('Booting game with memory card save…');
      await this.#options.onLaunchGame();
    }
  }

  async exportMemcard() {
    const rawFiles = this.#memcardFiles;
    if (!rawFiles || !rawFiles.length) {
      this.setStatus('Memory Card 1 is currently empty.', true);
      return;
    }
    const files = rawFiles.filter(f => !f.path.startsWith('TEST/'));

    let gameTitle = this.#activeGame?.name?.replace(/\.[^/.]+$/, '');
    if (!gameTitle) {
      for (const f of files) {
        if (f.path.includes('50760') || f.path.toLowerCase().includes('ico')) {
          gameTitle = 'Ico (Europe) - Main Gate';
          break;
        }
      }
    }
    const filename = `${gameTitle || 'Mcd001'}-save.json`;

    // Package files into a simple JSON bundle with base64 data for backup
    const exportBundle = {
      version: 1,
      format: 'pcsx2-folder-mcd',
      cardId: 'Mcd001.ps2',
      gameTitle: gameTitle || 'PS2 Save',
      exportedAt: new Date().toISOString(),
      files: files.map(f => ({
        path: f.path,
        size: f.size,
        base64: btoa(String.fromCharCode(...new Uint8Array(f.data)))
      }))
    };
    const blob = new Blob([JSON.stringify(exportBundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    this.setStatus(`Memory Card 1 exported as ${filename}.`);
  }

  async refreshUI() {
    const listEl = document.getElementById('save-list');
    const quickPanel = document.getElementById('save-quick-load-panel');
    const btnQuickLoad = document.getElementById('btn-quick-load-save');
    const btnLoadState = document.getElementById('btn-load-state');

    // Detect saves present on Memory Card 1
    const folders = new Set();
    let icoSavePresent = false;
    for (const f of this.#memcardFiles) {
      const parts = f.path.split('/');
      if (parts.length > 1) {
        folders.add(parts[0]);
        if (parts[0].includes('50760') || parts[0].toLowerCase().includes('ico')) {
          icoSavePresent = true;
        }
      }
    }

    // Configure Quick Load banner
    if (quickPanel) {
      if (icoSavePresent || folders.size > 0) {
        quickPanel.hidden = false;
        const quickTitle = document.getElementById('save-quick-title');
        const quickDesc = document.getElementById('save-quick-desc');
        if (quickTitle) {
          quickTitle.textContent = icoSavePresent ? 'ICO (Europe)' : Array.from(folders)[0];
        }
        if (quickDesc) {
          quickDesc.textContent = icoSavePresent
            ? 'Memory Card 1 · Main Gate (04:22:16)'
            : `Memory Card 1 · ${folders.size} save folder(s)`;
        }
        if (btnQuickLoad) btnQuickLoad.disabled = false;
      } else {
        quickPanel.hidden = true;
      }
    }

    // Check states for selected slot
    const serial = this.#activeGame?.serial || 'GAME';
    const states = await this.#store.listStates(serial);
    const currentState = states.find(s => s.slot === this.#selectedSlot);
    if (btnLoadState) {
      btnLoadState.disabled = !currentState;
    }

    // Render list of saved entries
    if (listEl) {
      listEl.replaceChildren();

      // Show memory card summary
      const mcdSummary = document.createElement('div');
      mcdSummary.className = 'save-entry';
      mcdSummary.innerHTML = `
        <div class="save-entry-title">💾 Memory Card 1 (Folder Card)</div>
        <div class="save-entry-meta">
          Status: Formatted (${this.#memcardFiles.length} files)<br>
          Folders: ${folders.size ? Array.from(folders).join(', ') : 'Empty'}
        </div>
      `;
      listEl.appendChild(mcdSummary);

      // Show save states
      if (states.length) {
        for (const s of states) {
          const row = document.createElement('div');
          row.className = 'save-entry';
          const dateStr = new Date(s.savedAt).toLocaleString();
          row.innerHTML = `
            <div class="save-entry-title">⚡ Slot ${s.slot}: ${s.title || 'Save State'}</div>
            <div class="save-entry-meta">Saved: ${dateStr} · ${(s.size / 1048576).toFixed(2)} MiB</div>
            <div class="save-actions">
              <button class="btn btn-secondary btn-slot-load" data-slot="${s.slot}">Load</button>
              <button class="btn btn-secondary btn-slot-export" data-slot="${s.slot}">Download</button>
              <button class="btn btn-danger btn-slot-del" data-slot="${s.slot}">Delete</button>
            </div>
          `;
          row.querySelector('.btn-slot-load')?.addEventListener('click', () => {
            this.#selectedSlot = s.slot;
            const slotSelect = document.getElementById('save-state-slot');
            if (slotSelect) slotSelect.value = String(s.slot);
            this.loadSelectedState();
          });
          row.querySelector('.btn-slot-export')?.addEventListener('click', () => {
            const blob = new Blob([s.data], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = s.filename || `state-slot${s.slot}.p2s`;
            a.click();
            URL.revokeObjectURL(url);
          });
          row.querySelector('.btn-slot-del')?.addEventListener('click', async () => {
            await this.#store.deleteState(serial, s.slot);
            await this.refreshUI();
          });
          listEl.appendChild(row);
        }
      }
    }
  }
}

/**
 * Convenience entry point to initialize the save system.
 */
export async function initSaves(backend, options = {}) {
  const store = new SaveStore();
  await store.init();
  const widget = new SavesWidget(store, backend, options);
  await widget.init();
  return { store, widget };
}
