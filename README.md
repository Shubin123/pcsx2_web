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
Compressed archives and game catalog downloads are not implemented.

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
mobile overflow and disabled Play state. Test files are generated data; no
BIOS or games are shipped. Screenshots and report are written to `artifacts/`.
These tests do not establish game compatibility or gameplay performance.

## Source and credits

- PCSX2 Dev Team: https://github.com/PCSX2/pcsx2, GPL-3.0+.
- Backend/build separation, extract/cache/replay design, panel-based UI, and
  the same-origin isolation service worker follow Shubin123's
  [azahar_emscripten](https://github.com/Shubin123/azahar_emscripten) and
  [azahar_web](https://github.com/Shubin123/azahar_web).
- `web/coi-serviceworker.js` is adapted from `azahar_web` commit
  `2064d01bb28c4acf0b8821b61a521f80f22f7c40`.
- New frontend code and the distributed PCSX2 components use GPL-3.0+;
  see `COPYING.GPLv3`. Backend dependency/source license notices remain in
  the backend repository.

See [the backend port status](https://github.com/Shubin123/pcsx2_emscripten/blob/main/WEB_PORT.md)
for the remaining CPU, memory, graphics, audio, and VM work.
