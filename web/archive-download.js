// SPDX-License-Identifier: GPL-3.0+
// A local server can stream Archive responses without browser CORS redirects.
// Static deployments have no proxy and keep the direct-link/local-import path.
export async function fetchArchiveDownload(game, signal) {
  try {
    return await fetch(game.url, { signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof TypeError)) throw error;
    let response;
    try {
      response = await fetch(`./archive-download?file=${encodeURIComponent(game.name)}`, { signal });
    } catch (fallbackError) {
      signal?.throwIfAborted();
      throw new Error('The archive could not be reached. Retry or import a local file.', { cause: fallbackError });
    }
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel();
      throw new Error('The browser could not access the archive download, and this host has no download relay.', { cause: error });
    }
    return response;
  }
}
