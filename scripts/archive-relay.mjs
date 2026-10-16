// SPDX-License-Identifier: GPL-3.0+
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const base = 'https://archive.org/download/playstation-2-games-iso/';
const archiveHost = url => url.protocol === 'https:' &&
  (url.hostname === 'archive.org' || url.hostname.endsWith('.archive.org')) &&
  !url.username && !url.password && (!url.port || url.port === '443');

// Fixed collection, no caller-supplied host, cookies or authorization. Inject
// fetch in tests so relay checks never contact Archive or download game data.
export async function relayArchive(request, response, url, headers, fetchArchive = fetch) {
  const name = url.searchParams.get('file');
  if (!name || name.length > 2048 || !/\.(iso|bin|elf)$/i.test(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f\x7f]/.test(name)) {
    response.writeHead(400, headers); response.end('Invalid archive filename'); return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  response.once('close', cancel);
  let upstream;
  let timeout;
  try {
    let target = new URL(base + name.split('/').map(encodeURIComponent).join('/'));
    // Bound time to response headers, not the entire multi-GiB transfer.
    timeout = setTimeout(cancel, 30000);
    for (let redirect = 0; ; redirect++) {
      upstream = await fetchArchive(target.href, { signal: controller.signal, redirect: 'manual', headers: { 'Accept-Encoding': 'identity' } });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get('location');
      await upstream.body?.cancel();
      if (!location || redirect >= 5) throw new Error('Invalid archive redirect');
      target = new URL(location, target);
      if (!archiveHost(target)) throw new Error('Invalid archive redirect host');
    }
    clearTimeout(timeout);
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      response.writeHead(upstream.ok ? 502 : upstream.status, headers);
      response.end('Archive download unavailable'); return;
    }
    const forwarded = { ...headers, 'Content-Type': 'application/octet-stream' };
    const length = upstream.headers.get('content-length');
    if (length && /^\d+$/.test(length)) forwarded['Content-Length'] = length;
    response.writeHead(200, forwarded);
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch {
    if (!response.destroyed) {
      if (response.headersSent) response.destroy();
      else { response.writeHead(502, headers); response.end('Archive download unavailable'); }
    }
  } finally {
    clearTimeout(timeout);
    response.removeListener('close', cancel);
  }
}
