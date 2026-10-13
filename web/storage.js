// SPDX-License-Identifier: GPL-3.0+
// Azahar's extract/cache/replay structure, using streaming OPFS writes.
const directory = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('pcsx2-library', { create: true });
export async function listGames() {
  if (!navigator.storage?.getDirectory) return [];
  const dir = await directory();
  const games = [];
  for await (const [name, handle] of dir.entries()) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(await (await handle.getFile()).text());
      if (!/^[a-f0-9-]{36}$/.test(meta.id) || !['disc', 'bios'].includes(meta.kind)) continue;
      const data = await (await dir.getFileHandle(`${meta.id}.blob`)).getFile();
      if (data.size === meta.size) games.push(meta);
    } catch { /* Interrupted writes are never shown as complete games. */ }
  }
  return games.sort((a, b) => b.imported - a.imported);
}
export async function cacheFile(file, kind, onProgress = () => {}, signal) {
  return cacheStream(file.stream(), file.name, file.size, kind, onProgress, signal);
}
export async function cacheStream(stream, name, size, kind, onProgress = () => {}, signal) {
  const file = { name, size };
  if (!navigator.storage?.getDirectory) throw new Error('Browser storage is unavailable. Uncheck Save in browser storage to load directly.');
  if (!['disc', 'bios'].includes(kind)) throw new Error('Invalid library entry kind');
  const { quota, usage } = await navigator.storage.estimate();
  if (quota && file.size > quota - usage) throw new Error('Not enough browser storage. Load directly or remove a cached game.');
  const dir = await directory();
  const id = crypto.randomUUID();
  let writable;
  let reader;
  try {
    writable = await (await dir.getFileHandle(`${id}.blob`, { create: true })).createWritable();
    reader = stream.getReader();
    let written = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      await writable.write(value);
      written += value.byteLength;
      onProgress(written / file.size);
    }
    signal?.throwIfAborted();
    if (written !== size) throw new Error(`Incomplete download: expected ${size} bytes, received ${written}.`);
    await writable.close();
    writable = null;
    const meta = { id, kind, name: file.name, size: file.size, imported: Date.now() };
    const metadata = await (await dir.getFileHandle(`${id}.json`, { create: true })).createWritable();
    await metadata.write(JSON.stringify(meta));
    await metadata.close();
    return meta;
  } catch (error) {
    await reader?.cancel().catch(() => {});
    await writable?.abort().catch(() => {});
    await dir.removeEntry(`${id}.blob`).catch(() => {});
    await dir.removeEntry(`${id}.json`).catch(() => {});
    throw error;
  } finally { reader?.releaseLock(); }
}
export async function getCachedFile(meta) {
  if (!/^[a-f0-9-]{36}$/.test(meta.id)) throw new Error('Invalid library entry');
  const file = await (await (await directory()).getFileHandle(`${meta.id}.blob`)).getFile();
  return new File([file], meta.name, { lastModified: meta.imported });
}
export async function removeCachedFile(meta) {
  if (!/^[a-f0-9-]{36}$/.test(meta.id)) throw new Error('Invalid library entry');
  const dir = await directory();
  await dir.removeEntry(`${meta.id}.json`);
  await dir.removeEntry(`${meta.id}.blob`);
}
