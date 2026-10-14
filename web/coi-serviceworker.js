// SPDX-License-Identifier: GPL-3.0+
// Adapted from Shubin123/azahar_web, 2064d01bb28c4acf0b8821b61a521f80f22f7c40.
// Adds the cross-origin isolation headers needed by Emscripten pthreads on
// static hosts such as GitHub Pages. The first visit reloads once after this
// worker takes control; normal servers should still send these headers
// directly, which avoids the reload.
'use strict';

self.addEventListener('install', event => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    const requestUrl = new URL(event.request.url);
    if (requestUrl.origin !== self.location.origin) return;

    event.respondWith((async () => {
        // Unversioned page files must not mix across deploys (static hosts cache them for
        // minutes): revalidate them. Runtime files carry ?v=<sha256> and may stay cached.
        const versioned = requestUrl.searchParams.has('v');
        const response = versioned ? await fetch(event.request)
            : await fetch(event.request.mode === 'navigate' ? requestUrl.href : event.request, { cache: 'no-cache' });
        if (response.type === 'opaque') return response;

        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Resource-Policy', 'same-origin');
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    })());
});
