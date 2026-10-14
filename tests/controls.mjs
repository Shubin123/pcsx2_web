// SPDX-License-Identifier: GPL-3.0+
// Controller test suite, fastest layer first. Each layer catches a different failure:
//   1 unit      keyboard.js logic (mapping, focus rules, hotkeys, rebinding)      Node, ms
//   2 contract  page bindings vs the shipped Wasm core, read back from the pad    Node, ~1 s
//   3 browser   trusted keys in Chrome through page, worker and a booted VM       BIOS, ~1 min
//   4 game      a real game reacting to keys at its menu                          BIOS + game, ~3 min
// The backend's CTest web-keyboard-input covers the core side of layer 2 for all 24 inputs.
// Layers without local media are reported as SKIP, never as passed.
import { spawnSync } from 'node:child_process';
const layers = [
  ['unit', ['--test', 'tests/input-unit.mjs']],
  ['contract', ['--test', 'tests/input-contract.mjs']],
  ['browser', ['tests/input-browser.mjs']],
  ['game', ['tests/game-controls.mjs']]
];
const only = process.argv[2];
const summary = [];
for (const [name, args] of layers) {
  if (only && only !== name) continue;
  console.log(`\n=== ${name} ===`);
  const started = Date.now();
  const { status } = spawnSync(process.execPath, args, { stdio: 'inherit' });
  const outcome = status === 0 ? 'PASS' : status === 77 ? 'SKIP' : 'FAIL';
  summary.push(`${outcome.padEnd(4)}  ${name.padEnd(8)} ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (outcome === 'FAIL') break; // later layers would only repeat the failure, slower
}
console.log(`\n${summary.join('\n')}`);
process.exit(summary.some(line => line.startsWith('FAIL')) ? 1 : 0);
