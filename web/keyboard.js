// SPDX-License-Identifier: GPL-3.0+
// Keyboard controls. The page owns the layout: it sends the DualShock 2 bindings to the core
// (Pad1 section, upstream "Keyboard/<key>" names) and handles its own hotkeys. Key events go to
// the core's InputManager by key name, so remapping needs no per-frame messages.

// KeyboardEvent.code is layout-independent; the core uses upstream's Qt-style key names.
const named = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', NumpadEnter: 'KeypadEnter',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt',
  MetaLeft: 'Meta', MetaRight: 'Meta', Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Escape: 'Escape',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', CapsLock: 'CapsLock',
  Minus: 'Minus', Equal: 'Equal', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight', Backslash: 'Backslash',
  Semicolon: 'Semicolon', Quote: 'Apostrophe', Backquote: 'QuoteLeft', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
  NumpadMultiply: 'KeypadMultiply', NumpadAdd: 'KeypadPlus', NumpadSubtract: 'KeypadMinus', NumpadDecimal: 'KeypadPeriod',
  NumpadDivide: 'KeypadDivide'
};
export function keyName(code) {
  if (named[code]) return named[code];
  let match;
  if ((match = /^Key([A-Z])$/.exec(code))) return match[1];
  if ((match = /^Digit([0-9])$/.exec(code))) return match[1];
  if ((match = /^Numpad([0-9])$/.exec(code))) return `Keypad${match[1]}`;
  if ((match = /^F([1-9]|1[0-2])$/.exec(code))) return code;
  return null;
}
export function keyLabel(code) {
  if (!code) return '—';
  const labels = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'Shift' };
  return labels[code] || keyName(code) || code;
}

// Pad1 binding names from upstream PadDualshock2.
export const actions = [
  { id: 'Up', label: 'D-pad up', group: 'pad' }, { id: 'Down', label: 'D-pad down', group: 'pad' },
  { id: 'Left', label: 'D-pad left', group: 'pad' }, { id: 'Right', label: 'D-pad right', group: 'pad' },
  { id: 'Cross', label: 'Cross ✕', group: 'pad' }, { id: 'Circle', label: 'Circle ○', group: 'pad' },
  { id: 'Square', label: 'Square □', group: 'pad' }, { id: 'Triangle', label: 'Triangle △', group: 'pad' },
  { id: 'Start', label: 'Start', group: 'pad' }, { id: 'Select', label: 'Select', group: 'pad' },
  { id: 'L1', label: 'L1', group: 'pad' }, { id: 'R1', label: 'R1', group: 'pad' },
  { id: 'L2', label: 'L2', group: 'pad' }, { id: 'R2', label: 'R2', group: 'pad' },
  { id: 'L3', label: 'L3', group: 'pad' }, { id: 'R3', label: 'R3', group: 'pad' },
  { id: 'LUp', label: 'Left stick up', group: 'pad' }, { id: 'LDown', label: 'Left stick down', group: 'pad' },
  { id: 'LLeft', label: 'Left stick left', group: 'pad' }, { id: 'LRight', label: 'Left stick right', group: 'pad' },
  { id: 'RUp', label: 'Right stick up', group: 'pad' }, { id: 'RDown', label: 'Right stick down', group: 'pad' },
  { id: 'RLeft', label: 'Right stick left', group: 'pad' }, { id: 'RRight', label: 'Right stick right', group: 'pad' },
  { id: 'pause', label: 'Pause / resume', group: 'hotkey' }, { id: 'fastForward', label: 'Fast-forward (hold)', group: 'hotkey' },
  { id: 'fullscreen', label: 'Fullscreen', group: 'hotkey' }
];
export const defaults = {
  Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  Cross: 'KeyZ', Circle: 'KeyX', Square: 'KeyA', Triangle: 'KeyS', Start: 'Enter', Select: 'ShiftRight',
  L1: 'KeyQ', R1: 'KeyW', L2: 'KeyE', R2: 'KeyR', L3: 'KeyC', R3: 'KeyV',
  LUp: 'KeyI', LDown: 'KeyK', LLeft: 'KeyJ', LRight: 'KeyL', RUp: 'KeyT', RDown: 'KeyG', RLeft: 'KeyF', RRight: 'KeyH',
  pause: 'KeyP', fastForward: 'Tab', fullscreen: 'F11'
};
const storageKey = 'pcsx2-keyboard';

// Only fields that take typed text keep keys from the game. Buttons, checkboxes and selects
// (focused after the user adjusts a setting) must not swallow controller keys mid-game.
const textTypes = new Set(['text', 'search', 'email', 'number', 'password', 'url', 'tel']);
export function isTextEntry(target) {
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest('textarea,[contenteditable=""],[contenteditable=true]')) return true;
  return target.tagName === 'INPUT' && textTypes.has((target.type || 'text').toLowerCase());
}

export class Keyboard {
  #bindings = { ...defaults };
  #pressed = new Map(); // code -> key name sent to the core
  #capture = null;
  session = false; // a game is loaded: hotkeys are live (otherwise the page keeps every key)
  enabled = false; // the game is running: controller keys go to the core
  onPadKey = (_name, _pressed) => {};
  onHotkey = (_id, _pressed) => {};
  onBindingsChanged = () => {};
  onCapture = (_id) => {};
  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      for (const { id } of actions) if (typeof saved?.[id] === 'string' || saved?.[id] === null) this.#bindings[id] = saved[id];
    } catch {}
    window.addEventListener('keydown', event => this.#key(event, true));
    window.addEventListener('keyup', event => this.#key(event, false));
    // Released keys are never seen while the page lacks focus; release them so nothing sticks.
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
  }
  get bindings() { return { ...this.#bindings }; }
  /** Settings lines for pcsx2_vm_set_settings: every Pad1 button, bound or cleared. */
  settingsLines() {
    return actions.filter(a => a.group === 'pad').map(({ id }) => {
      const name = this.#bindings[id] && keyName(this.#bindings[id]);
      return `Pad1\t${id}\t${name ? `Keyboard/${name}` : ''}`;
    }).join('\n');
  }
  capture(id) { this.#capture = id; this.onCapture(id); }
  cancelCapture() { this.#capture = null; this.onCapture(null); }
  bind(id, code) {
    // One key, one action: rebinding takes the key from wherever it was.
    for (const other of Object.keys(this.#bindings)) if (this.#bindings[other] === code) this.#bindings[other] = null;
    this.#bindings[id] = code;
    this.#save();
  }
  reset() { this.#bindings = { ...defaults }; this.#save(); }
  releaseAll() {
    for (const [code, name] of this.#pressed) {
      if (name) this.onPadKey(name, false);
      else this.onHotkey(this.#actionFor(code), false);
    }
    this.#pressed.clear();
  }
  #save() {
    this.releaseAll();
    try { localStorage.setItem(storageKey, JSON.stringify(this.#bindings)); } catch {}
    this.onBindingsChanged();
  }
  #actionFor(code) { return actions.find(({ id }) => this.#bindings[id] === code)?.id; }
  #key(event, down) {
    if (this.#capture) {
      if (!down) return;
      event.preventDefault();
      const id = this.#capture;
      this.#capture = null;
      if (event.code !== 'Escape' && keyName(event.code)) this.bind(id, event.code);
      this.onCapture(null);
      return;
    }
    if (!this.session || isTextEntry(event.target)) return;
    if (down && event.repeat) { if (this.#pressed.has(event.code)) event.preventDefault(); return; }
    if (!down && !this.#pressed.has(event.code)) return;
    const id = this.#actionFor(event.code);
    if (!id || event.ctrlKey || event.metaKey || (event.altKey && event.code !== 'AltLeft' && event.code !== 'AltRight')) {
      // Browser shortcuts stay usable; a modifier pressed mid-hold still releases the key.
      if (!down && this.#pressed.has(event.code)) this.#release(event.code);
      return;
    }
    const action = actions.find(a => a.id === id);
    if (action.group === 'pad' && !this.enabled && down) return;
    event.preventDefault();
    if (!down) { this.#release(event.code); return; }
    if (action.group === 'pad') {
      const name = keyName(event.code);
      this.#pressed.set(event.code, name);
      this.onPadKey(name, true);
    } else {
      this.#pressed.set(event.code, null);
      this.onHotkey(id, true);
    }
  }
  #release(code) {
    const name = this.#pressed.get(code);
    this.#pressed.delete(code);
    if (name) this.onPadKey(name, false);
    else this.onHotkey(this.#actionFor(code), false);
  }
}
