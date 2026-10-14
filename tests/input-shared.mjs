// SPDX-License-Identifier: GPL-3.0+
// Upstream PadDualshock2 binding names in Inputs order (index = byte from pcsx2_vm_pad_inputs).
// PAD_ANALOG (16) and PAD_PRESSURE (17) have no page binding.
export const padInputs = { Up: 0, Right: 1, Down: 2, Left: 3, Triangle: 4, Circle: 5, Cross: 6, Square: 7, Select: 8, Start: 9,
  L1: 10, L2: 11, R1: 12, R2: 13, L3: 14, R3: 15, LUp: 18, LRight: 19, LDown: 20, LLeft: 21, RUp: 22, RRight: 23, RDown: 24, RLeft: 25 };
export const padInputCount = 26;
/** Every KeyboardEvent.code the page can bind. */
export const bindableCodes = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => `Key${c}`), ...'0123456789'.split('').map(d => `Digit${d}`),
  ...'0123456789'.split('').map(d => `Numpad${d}`), ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'NumpadEnter', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'Space', 'Tab', 'Backspace', 'Escape', 'Insert', 'Delete', 'Home', 'End', 'PageUp',
  'PageDown', 'CapsLock', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Backquote', 'Comma',
  'Period', 'Slash', 'NumpadMultiply', 'NumpadAdd', 'NumpadSubtract', 'NumpadDecimal', 'NumpadDivide'];
