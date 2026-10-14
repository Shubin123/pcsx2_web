// SPDX-License-Identifier: GPL-3.0+
// Gamepad detection. Keyboard controls are in keyboard.js; gamepad buttons are not yet
// forwarded to the emulator core.
export function startInput(onGamepad) {
  let last;
  function poll() {
    const pad = [...navigator.getGamepads()].find(pad => pad?.connected);
    const id = pad?.id || null;
    if (id !== last) { last = id; onGamepad(id); }
    requestAnimationFrame(poll);
  }
  window.addEventListener('gamepadconnected', () => requestAnimationFrame(poll), { once: true });
  onGamepad(null);
}
