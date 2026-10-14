// SPDX-License-Identifier: GPL-3.0+
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
const sourceArgument = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const source = path.resolve(sourceArgument || fileURLToPath(new URL('../../pcsx2_emscripten/build-web/web/', import.meta.url)));
const destination = fileURLToPath(new URL('../web/runtime/', import.meta.url));
const manifestBytes = await readFile(path.join(source, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
if (manifest.schema !== 1 || manifest.abi !== 1 || !['portability-components', 'full-emulator'].includes(manifest.kind)) throw new Error('Unsupported artifact manifest');
const payloads = [];
for (const [name, meta] of Object.entries(manifest.files)) {
  if (!/^pcsx2-(port|vm)\.[a-z0-9.]+$/.test(name)) throw new Error('Unsafe artifact filename');
  const bytes = await readFile(path.join(source, name));
  if (bytes.length !== meta.bytes || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw new Error(`Artifact checksum mismatch: ${name}`);
  payloads.push([name, bytes]);
}
if (!payloads.some(([name]) => name === manifest.entry)) throw new Error('Missing required artifacts');
await mkdir(destination, { recursive: true });
for (const name of await readdir(destination)) if (/^pcsx2-(port|vm)\./.test(name) && !manifest.files[name]) await unlink(path.join(destination, name));
for (const [name, bytes] of payloads) await writeFile(path.join(destination, name), bytes);
if (process.argv.includes('--with-source')) {
  const backend = fileURLToPath(new URL('../../pcsx2_emscripten/', import.meta.url));
  const revision = manifest.backendRevision;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid source revision');
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: backend, encoding: 'utf8' }).trim() !== revision ||
      execFileSync('git', ['status', '--porcelain'], { cwd: backend, encoding: 'utf8' }).trim()) {
    throw new Error('Source packaging requires the committed, clean backend revision matching the runtime manifest');
  }
  const filename = 'pcsx2-source.tar.gz';
  const child = spawn('git', ['archive', '--format=tar', '--prefix=pcsx2-source/', revision], { cwd: backend, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(error || `git archive exited ${code}`)));
  });
  await Promise.all([pipeline(child.stdout, createGzip({ level: 9 }), createWriteStream(path.join(destination, filename))), completed]);
  const archive = await readFile(path.join(destination, filename));
  manifest.sourceArchive = { file: filename, revision, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') };
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
} else {
  await writeFile(path.join(destination, 'manifest.json'), manifestBytes);
}
console.log(`Verified and synced ${payloads.length} backend artifacts (emulation=${manifest.emulation})`);
