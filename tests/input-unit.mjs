// SPDX-License-Identifier: GPL-3.0+
// Layer 1: keyboard.js logic in Node with a minimal DOM. No browser, BIOS or game.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

// Minimal browser globals for keyboard.js.
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { hidden: false });
const { Keyboard, actions, defaults, keyName, keyLabel, isTextEntry } = await import('../web/keyboard.js');
const { padInputs, bindableCodes } = await import('./input-shared.mjs');

class Key extends Event {
  #target;
  constructor(type, code, { target, repeat = false, ctrlKey = false, metaKey = false, altKey = false } = {}) {
    super(type, { cancelable: true });
    Object.assign(this, { code, repeat, ctrlKey, metaKey, altKey });
    this.#target = target;
  }
  get target() { return this.#target ?? window; }
}
const element = (tagName, type) => ({ tagName, type, closest: selector => (tagName === 'TEXTAREA' && selector.includes('textarea')) ? {} : null });

// Every Keyboard listens on window; switch them all off after each test, even a failed one.
const keyboards = [];
afterEach(() => { for (const k of keyboards) k.session = k.enabled = false; });

function setup({ session = true, enabled = true } = {}) {
  store.clear();
  const keyboard = new Keyboard();
  keyboards.push(keyboard);
  const pad = [], hotkeys = [];
  keyboard.onPadKey = (name, pressed) => pad.push([name, pressed]);
  keyboard.onHotkey = (id, pressed) => hotkeys.push([id, pressed]);
  keyboard.session = session;
  keyboard.enabled = enabled;
  const press = (code, options) => { const e = new Key('keydown', code, options); window.dispatchEvent(e); return e; };
  const release = (code, options) => { const e = new Key('keyup', code, options); window.dispatchEvent(e); return e; };
  return { keyboard, pad, hotkeys, press, release, dispose: () => { keyboard.session = keyboard.enabled = false; } };
}

test('default layout binds every controller input to a distinct key the core can name', () => {
  assert.deepEqual(actions.filter(a => a.group === 'pad').map(a => a.id).sort(), Object.keys(padInputs).sort());
  for (const { id } of actions) assert.ok(defaults[id], `${id} has a default key`);
  const codes = Object.values(defaults);
  assert.equal(new Set(codes).size, codes.length, 'default keys are distinct');
  for (const code of codes) assert.ok(keyName(code), `${code} maps to a core key name`);
  for (const code of bindableCodes) assert.ok(keyName(code), `${code} is bindable`);
});

test('key names follow upstream Qt-style names', () => {
  const cases = { KeyZ: 'Z', Digit3: '3', ArrowUp: 'Up', Enter: 'Return', NumpadEnter: 'KeypadEnter', Numpad7: 'Keypad7', ShiftRight: 'Shift',
    Space: 'Space', Backquote: 'QuoteLeft', Quote: 'Apostrophe', F1: 'F1', F12: 'F12', Tab: 'Tab' };
  for (const [code, name] of Object.entries(cases)) assert.equal(keyName(code), name, code);
  for (const code of ['F13', 'IntlBackslash', 'MediaPlayPause', 'Fn', '']) assert.equal(keyName(code), null, code);
  assert.equal(keyLabel('ArrowLeft'), '←');
  assert.equal(keyLabel(null), '—');
});

test('settings lines bind all 24 controller inputs', () => {
  const { keyboard, dispose } = setup();
  const lines = keyboard.settingsLines().split('\n');
  assert.equal(lines.length, 24);
  for (const line of lines) assert.match(line, /^Pad1\t[A-Za-z0-9]+\tKeyboard\/[A-Za-z0-9]+$/);
  assert.ok(lines.includes('Pad1\tCross\tKeyboard/Z'));
  assert.ok(lines.includes('Pad1\tStart\tKeyboard/Return'));
  dispose();
});

test('controller keys are forwarded once per press and released', () => {
  const { pad, press, release, dispose } = setup();
  const down = press('KeyZ');
  assert.equal(down.defaultPrevented, true);
  press('KeyZ', { repeat: true });
  release('KeyZ');
  assert.deepEqual(pad, [['Z', true], ['Z', false]]);
  dispose();
});

test('nothing is intercepted without a game session', () => {
  const { pad, hotkeys, press, release, dispose } = setup({ session: false, enabled: false });
  for (const code of ['KeyZ', 'Tab', 'KeyP', 'ArrowUp']) {
    assert.equal(press(code).defaultPrevented, false, `${code} keeps its browser behaviour`);
    release(code);
  }
  assert.deepEqual(pad, []);
  assert.deepEqual(hotkeys, []);
  dispose();
});

test('paused: controller keys are ignored but hotkeys work', () => {
  const { pad, hotkeys, press, release, dispose } = setup({ enabled: false });
  press('KeyZ'); release('KeyZ');
  press('KeyP'); release('KeyP');
  assert.deepEqual(pad, []);
  assert.deepEqual(hotkeys, [['pause', true], ['pause', false]]);
  dispose();
});

test('text fields keep their keys; buttons, checkboxes and selects do not', () => {
  assert.equal(isTextEntry(element('INPUT', 'search')), true);
  assert.equal(isTextEntry(element('INPUT', 'text')), true);
  assert.equal(isTextEntry(element('TEXTAREA')), true);
  assert.equal(isTextEntry(element('INPUT', 'checkbox')), false);
  assert.equal(isTextEntry(element('SELECT')), false);
  assert.equal(isTextEntry(element('BUTTON')), false);
  const { pad, press, release, dispose } = setup();
  press('KeyZ', { target: element('INPUT', 'search') });
  press('ArrowUp', { target: element('SELECT') });
  release('ArrowUp', { target: element('SELECT') });
  assert.deepEqual(pad, [['Up', true], ['Up', false]]);
  dispose();
});

test('browser shortcuts pass through, and a held key still releases', () => {
  const { pad, press, release, dispose } = setup();
  assert.equal(press('KeyZ', { ctrlKey: true }).defaultPrevented, false);
  press('KeyX');
  release('KeyX', { metaKey: true });
  assert.deepEqual(pad, [['X', true], ['X', false]]);
  dispose();
});

test('losing focus releases every held key', () => {
  const { pad, hotkeys, press, dispose } = setup();
  press('KeyZ'); press('ArrowLeft'); press('Tab');
  window.dispatchEvent(new Event('blur'));
  assert.deepEqual(pad.filter(([, p]) => !p).map(([n]) => n).sort(), ['Left', 'Z']);
  assert.deepEqual(hotkeys.at(-1), ['fastForward', false]);
  dispose();
});

test('rebinding moves a key, unbinds its old action, and persists', () => {
  const { keyboard, pad, press, release, dispose } = setup();
  let changed = 0;
  keyboard.onBindingsChanged = () => changed++;
  keyboard.capture('Cross');
  press('KeyZ'); // already Cross: binding to itself is allowed
  keyboard.capture('Circle');
  press('KeyZ'); // take Z from Cross
  assert.equal(keyboard.bindings.Circle, 'KeyZ');
  assert.equal(keyboard.bindings.Cross, null);
  assert.ok(keyboard.settingsLines().split('\n').includes('Pad1\tCross\t'), 'Cross is sent unbound');
  assert.equal(JSON.parse(store.get('pcsx2-keyboard')).Circle, 'KeyZ');
  assert.equal(changed, 2);
  const reloaded = new Keyboard();
  keyboards.push(reloaded);
  assert.equal(reloaded.bindings.Circle, 'KeyZ');
  reloaded.session = false;
  pad.length = 0;
  press('KeyZ'); release('KeyZ');
  assert.deepEqual(pad, [['Z', true], ['Z', false]]); // same core key name, now bound to Circle
  dispose();
});

test('capture ignores Escape and keys the core cannot name; reset restores defaults', () => {
  const { keyboard, press, dispose } = setup();
  keyboard.capture('Cross');
  press('Escape');
  assert.equal(keyboard.bindings.Cross, 'KeyZ');
  keyboard.capture('Cross');
  press('F13');
  assert.equal(keyboard.bindings.Cross, 'KeyZ');
  keyboard.bind('Cross', 'KeyB');
  keyboard.reset();
  assert.deepEqual(keyboard.bindings, defaults);
  dispose();
});

test('corrupt saved bindings fall back to defaults', () => {
  store.set('pcsx2-keyboard', '{not json');
  const keyboard = new Keyboard();
  assert.deepEqual(keyboard.bindings, defaults);
  store.set('pcsx2-keyboard', JSON.stringify({ Cross: 42, Circle: 'KeyB' }));
  const partial = new Keyboard();
  assert.equal(partial.bindings.Cross, 'KeyZ');
  assert.equal(partial.bindings.Circle, 'KeyB');
});
