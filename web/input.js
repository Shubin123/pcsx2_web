// SPDX-License-Identifier: GPL-3.0+
// DualShock 2 order: Select L3 R3 Start Up Right Down Left L2 R2 L1 R1 Triangle Circle Cross Square.
// One shared packet per controller, ready for native consumption without per-frame messages.
const keys = new Map([['ShiftLeft', 0], ['ShiftRight', 0], ['Enter', 3], ['ArrowUp', 4], ['ArrowRight', 5], ['ArrowDown', 6], ['ArrowLeft', 7], ['KeyE', 8], ['KeyR', 9], ['KeyQ', 10], ['KeyW', 11], ['KeyS', 12], ['KeyX', 13], ['KeyZ', 14], ['KeyA', 15]]);
const standard = [14, 13, 15, 12, 10, 11, 8, 9, 0, 3, 1, 2, 4, 6, 7, 5];
export function startInput(onGamepad) {
  const buffer = new SharedArrayBuffer(32);
  const words = new Int32Array(buffer);
  const pressed = new Set();
  let suspended = false;
  const editable = target => target?.closest?.('input,textarea,select,[contenteditable=true]');
  window.addEventListener('keydown', event => {
    if (!keys.has(event.code) || editable(event.target)) return;
    event.preventDefault(); pressed.add(event.code);
  });
  window.addEventListener('keyup', event => pressed.delete(event.code));
  window.addEventListener('blur', () => { pressed.clear(); suspended = true; words.fill(0); });
  window.addEventListener('focus', () => { suspended = false; });
  document.addEventListener('visibilitychange', () => { pressed.clear(); suspended = document.hidden; words.fill(0); });
  function poll() {
    let buttons = 0;
    for (const code of pressed) buttons |= 1 << keys.get(code);
    const pad = [...navigator.getGamepads()].find(pad => pad?.connected && pad.mapping === 'standard');
    if (pad && !suspended) {
      pad.buttons.forEach((button, i) => { if (button.pressed && i < standard.length) buttons |= 1 << standard[i]; });
      for (let i = 0; i < 4; i++) Atomics.store(words, i + 2, Math.round((pad.axes[i] || 0) * 32767));
    } else for (let i = 2; i < 6; i++) Atomics.store(words, i, 0);
    Atomics.store(words, 1, suspended ? 0 : buttons);
    Atomics.add(words, 0, 1);
    onGamepad(pad?.id || null);
    requestAnimationFrame(poll);
  }
  requestAnimationFrame(poll);
  return buffer;
}
