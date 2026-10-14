// SPDX-License-Identifier: GPL-3.0+
// Layer 2: the page's real keyboard.js against the shipped Wasm runtime in Node. Checks that
// every binding the page sends reaches the emulated DualShock 2. No browser, BIOS or game.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';

const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { hidden: false });
const { Keyboard, actions, defaults, keyName } = await import('../web/keyboard.js');
const { padInputs, padInputCount, bindableCodes } = await import('./input-shared.mjs');

// The runtime is CommonJS, and this package is ESM: load a .cjs copy (its pthreads load the same file).
const runtime = fileURLToPath(new URL('../web/runtime/', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'pcsx2-input-'));
await copyFile(path.join(runtime, 'pcsx2-vm.js'), path.join(directory, 'pcsx2-vm.cjs'));
await copyFile(path.join(runtime, 'pcsx2-vm.wasm'), path.join(directory, 'pcsx2-vm.wasm'));
const vm = await createRequire(import.meta.url)(path.join(directory, 'pcsx2-vm.cjs'))({ print: () => {}, printErr: () => {} });
after(async () => { await rm(directory, { recursive: true, force: true }); setImmediate(() => process.exit(process.exitCode ?? 0)); });

assert.equal(vm._pcsx2_vm_init(), 1);
const call = (fn, text, ...args) => { const p = vm.stringToNewUTF8(text); try { return fn(p, ...args); } finally { vm._free(p); } };
const key = (name, pressed) => call(vm._pcsx2_vm_key, name, pressed ? 1 : 0);
const apply = lines => call(vm._pcsx2_vm_set_settings, lines);
const buffer = vm._malloc(64);
const read = () => { assert.equal(vm._pcsx2_vm_pad_inputs(buffer, 64), padInputCount); return Array.from(vm.HEAPU8.subarray(buffer, buffer + padInputCount)); };
const expected = (...inputs) => { const state = new Array(padInputCount).fill(0); for (const i of inputs) state[i] = 255; return state; };
// Input is applied on the core's CPU thread.
async function settle(state, what) {
  for (let i = 0; i < 400; i++) {
    if (JSON.stringify(read()) === JSON.stringify(state)) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.deepEqual(read(), state, what);
}

test('the core accepts every key name the page can produce', () => {
  for (const code of bindableCodes) {
    assert.equal(key(keyName(code), true), 1, `${code} -> ${keyName(code)}`);
    key(keyName(code), false);
  }
  assert.equal(key('NotAKey', true), 0);
});

test('every default binding reaches its DualShock 2 input, alone', async () => {
  const keyboard = new Keyboard();
  apply(keyboard.settingsLines());
  await settle(expected(), 'released after applying bindings');
  for (const { id } of actions.filter(a => a.group === 'pad')) {
    const name = keyName(defaults[id]);
    key(name, true);
    await settle(expected(padInputs[id]), `${id} via ${defaults[id]}`);
    key(name, false);
    await settle(expected(), `${id} released`);
  }
});

test('hotkeys are not bound in the core', async () => {
  for (const id of ['pause', 'fastForward', 'fullscreen']) {
    key(keyName(defaults[id]), true);
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(read(), expected(), id);
    key(keyName(defaults[id]), false);
  }
});

test('a key rebound in the page moves in the core and unbinds the old action', async () => {
  store.clear();
  const keyboard = new Keyboard();
  keyboard.bind('Circle', 'KeyZ'); // Z leaves Cross
  keyboard.bind('Cross', 'KeyB');
  apply(keyboard.settingsLines());
  await settle(expected());
  key('Z', true);
  await settle(expected(padInputs.Circle), 'Z now presses Circle');
  key('Z', false);
  key('X', true); // Circle's old key
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(read(), expected(), 'old Circle key is unbound');
  key('X', false);
  key('B', true);
  await settle(expected(padInputs.Cross), 'B presses Cross');
  key('B', false);
  keyboard.reset();
  apply(keyboard.settingsLines());
  key('Z', true);
  await settle(expected(padInputs.Cross), 'reset restores Z = Cross');
  key('Z', false);
  await settle(expected());
});

test('chords reach the pad together', async () => {
  for (const code of [defaults.Up, defaults.Cross, defaults.LRight, defaults.R2]) key(keyName(code), true);
  await settle(expected(padInputs.Up, padInputs.Cross, padInputs.LRight, padInputs.R2));
  for (const code of [defaults.Up, defaults.Cross, defaults.LRight, defaults.R2]) key(keyName(code), false);
  await settle(expected());
});
