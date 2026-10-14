import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = new URL('../', import.meta.url);
for (const folder of ['web/', 'scripts/', 'tests/']) for (const name of await readdir(new URL(folder, root))) if (/\.(m?js)$/.test(name)) {
  const result = spawnSync(process.execPath, ['--check', new URL(folder + name, root).pathname], { encoding: 'utf8' });
  if (result.status) throw new Error(result.stderr);
}
const runtime = new URL('web/runtime/', root);
const manifest = JSON.parse(await readFile(new URL('manifest.json', runtime)));
if (manifest.emulation !== false || manifest.kind !== 'portability-components') throw new Error('Unexpected backend capability');
for (const [name, meta] of Object.entries(manifest.files)) {
  if (path.basename(name) !== name) throw new Error('Invalid artifact path');
  const bytes = await readFile(new URL(name, runtime));
  if (bytes.length !== meta.bytes || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw new Error(`Artifact mismatch ${name}`);
}
if (manifest.sourceArchive) {
  const meta = manifest.sourceArchive;
  if (meta.file !== 'pcsx2-source.tar.gz' || meta.revision !== manifest.backendRevision) throw new Error('Source archive revision mismatch');
  const bytes = await readFile(new URL(meta.file, runtime));
  if (bytes.length !== meta.bytes || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw new Error('Source archive checksum mismatch');
}
console.log('PASS: JavaScript syntax and backend artifact checksums');
