# PCSX2 Web

Static browser frontend for [pcsx2_emscripten](https://github.com/Shubin123/pcsx2_emscripten),
modeled after [Azahar Web](https://github.com/Shubin123/azahar_web).

**The current backend contains PCSX2 graphics portability components. PS2
boot and game execution are not implemented yet. Play remains disabled.**

Working features: dedicated Wasm worker, SIMD GS kernel validation, read-only
ISO/BIN/ELF mounts, streaming OPFS cache, cached-file replay/removal, persisted
BIOS selection, import cancellation and quota checks, keyboard/gamepad packet
capture, fullscreen, and responsive layout. Input packets are not yet consumed
by a PS2 core. BIN mounting does not establish cue-sheet/CD image compatibility;
BIOS size checks do not validate whether a ROM is a correct PS2 BIOS.
The Internet Archive catalog at https://archive.org/download/playstation-2-games-iso
supports title search, region filters, sorting, pagination, refresh, and streamed
ISO/BIN/ELF downloads into OPFS with cancellation, quota checks, byte-length
verification and cached mounting. The catalog is fetched live; archive availability
and browser CORS permissions can affect downloads. Each title links to a direct
download for local import when browser fetch is blocked. A live browser check
loaded 378 catalog images; a live ISO range request failed to fetch, while the
fixture download/cache/mount test passed. Full live game downloads are unverified. Compressed archives are not
supported by this catalog importer.

The Azahar-style hamburger drawer supports persistent widget ordering, resizing,
collapse/hide, column spans, width, spacing, placement beside/below the screen,
and layout reset. Display filtering/shape and import caching preferences persist;
fullscreen (Alt+Enter), PNG screenshots, storage persistence requests and a session
log are available. The screenshot captures the current canvas, including an empty
canvas before a game-rendering backend exists.

Azahar gameplay features (renderer selection, internal resolution, fast-forward,
audio, frame stepping, save states and network play) require emulator APIs absent
from this component backend. They are not implemented. The PS2 has one display;
Azahar's dual-screen sizing and 3DS wireless controls do not apply.

## Run

Build the sibling backend first (see its `WEB_PORT.md`), then:

```sh
npm ci
npm run sync
npm run check
npm test
npm start
```

Open http://127.0.0.1:8080. The local server supplies COOP/COEP headers on all
responses. GitHub Pages uses the included same-origin service worker; the first
visit may reload once to enable cross-origin isolation.

## Deployment and build ownership

[GitHub Pages](https://shubin123.github.io/pcsx2_web/) publishes the checked-in
`web/` directory with a small upload/deploy workflow. It runs only when static
files or its workflow change, or when manually dispatched. It does not install
npm dependencies, run Chrome, or compile Wasm. Browser validation runs on pull
requests or manual dispatch independently of Pages.

Wasm compilation and component tests run in the private `pcsx2_emscripten`
repository on backend pushes, pull requests, or manual dispatch. Its workflow
uploads `pcsx2-web-components` with JavaScript, Wasm, and the checksum manifest.
Download that artifact as an authorized backend user, then run
`npm run sync -- /path/to/extracted/artifact` here and commit the updated
`web/runtime/` files. That static-file commit triggers Pages. The frontend
does not need a token to the private backend or a compiler in its deployment.

`npm run sync -- /path/to/backend/build-web/web` verifies SHA-256 hashes before
copying a complete backend artifact set into `web/runtime/`. Runtime files and
manifest are checked in together, so published frontend source exactly matches
the distributed component build. Keep full emulation artifacts separate from
the component manifest until the emulator ABI is implemented and tested.

## Validation

`npm test` uses a disposable Chrome profile (`CHROME_PATH` overrides the local
macOS default). It checks actual Wasm GS output against upstream scalar pixel
offsets, UI import, OPFS replay after reload, removal, cancellation cleanup,
and header/tail reads through WORKERFS at offsets above 3 GiB. It also checks
mobile overflow and disabled Play state. Widget sizing tests use mouse and touch
corner drags and check rendered dimensions, scrolled-content grip accessibility,
reload persistence, column buttons and drawer selection, width/spacing sliders,
below-screen placement, collapse/reset, cross-tab storage delivery, and overlap at
desktop/tablet/mobile widths. Screenshots at each sizing step plus hashes and
measured widget bounds are retained in `artifacts/widget-framebuffers/`. Test files are generated data; no
BIOS or games are shipped. Screenshots and report are written to `artifacts/`.
These tests do not establish game compatibility or gameplay performance.

## Source and credits

- PCSX2 Dev Team: https://github.com/PCSX2/pcsx2, GPL-3.0+.
- Backend/build separation, extract/cache/replay design, panel-based UI, and
  the same-origin isolation service worker follow Shubin123's
  [azahar_emscripten](https://github.com/Shubin123/azahar_emscripten) and
  [azahar_web](https://github.com/Shubin123/azahar_web).
- `web/layout.js` and widget/drawer CSS are adapted from Shubin123's
  `azahar_web/web/azahar_layout.js` and `web/index.html` at commit
  `2064d01bb28c4acf0b8821b61a521f80f22f7c40` (GPL-3.0+).
- `web/coi-serviceworker.js` is adapted from `azahar_web` commit
  `2064d01bb28c4acf0b8821b61a521f80f22f7c40`.
- New frontend code and the distributed PCSX2 components use GPL-3.0+;
  see `COPYING.GPLv3`. Backend dependency/source license notices remain in
  the backend repository.

See [the backend port status](https://github.com/Shubin123/pcsx2_emscripten/blob/main/WEB_PORT.md)
for the remaining CPU, memory, graphics, audio, and VM work.

### Local performance validation

The browser VM uses native Wasm exception handling; an unsupported browser
gets an update message before boot. In the local Apple M1 / Chrome 155 intro
benchmark, first video improved from 86.5 to 26.2 seconds and the visible
18–20 guest-second window improved from about 2.6 to 13–15 FPS. Full PAL speed
and gameplay FPS have not been verified.

`npm run test:performance` uses the real UI/canvas and requires `PS2_BIOS` and
`GAME_ISO` pointing to local files. It records guest time, vsyncs, internal FPS,
frame hashes, hardware/settings, Wasm checksum, and every worker's CPU profile
in `artifacts/performance/`. Use `PROFILE=0` to disable CPU sampling, `DURATION`
for wall-clock seconds, and `OUT` for another artifact directory. CPU profiles
with readable Wasm names need a backend built with `PCSX2_WEB_PROFILE=ON` and
synced first. Compare the same visible guest scene, not black startup frames
or canvas refresh counts. `node scripts/summarize-profile.mjs <directory>`
reports the 18–20 guest-second intro window.

The public runtime includes a [matching backend source archive](web/runtime/pcsx2-source.tar.gz),
with its revision and checksum in the runtime manifest. This contains the
committed fork source, build scripts, and dependency/license notices; it excludes
Git history, local BIOS/game files, build outputs, and profiling artifacts.
For a release, commit the backend changes, rebuild, then run
`npm run sync -- --with-source` from this frontend. Source packaging requires
a clean backend at the exact manifest revision. When building from the archive,
initialize a local Git repository before running its `tools/web/build.sh` so
revision metadata can be generated.
