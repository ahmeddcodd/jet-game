// input.js — keyboard + mouse input with pointer lock for flight
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    // Keys that went down since the last update(). One-shot actions (BFM
    // maneuvers, flares, target cycling) need the edge, not the held state.
    this.pressed = new Set();
    this._newPresses = new Set();
    this.mouseX = 0;     // -1..1 normalized
    this.mouseY = 0;
    this.mouseNX = 0;    // raw normalized, smoothed target
    this.mouseNY = 0;
    this.mouseDown = false;
    this.mouseDown2 = false;
    this.pointerLocked = false;
    this.sensitivity = 0.0022;
    this.deadzone = 0.05;

    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this._newPresses.add(e.code);  // ignore auto-repeat
      this.keys.add(e.code);
      // prevent space/arrow scroll
      // Tab would move focus off the canvas; Space/arrows would scroll.
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) {
        this.mouseNX = 0; this.mouseNY = 0;
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      // Accumulate movement; clamp to a sane range
      this.mouseNX = clamp(this.mouseNX + e.movementX * this.sensitivity, -1, 1);
      this.mouseNY = clamp(this.mouseNY + e.movementY * this.sensitivity, -1, 1);
    });

    document.addEventListener('mousedown', (e) => {
      if (!this.pointerLocked) return;
      if (e.button === 0) this.mouseDown = true;
      if (e.button === 2) this.mouseDown2 = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.mouseDown2 = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  requestPointerLock() {
    // Chrome returns a promise and rejects it if the lock is refused (e.g. a
    // re-lock too soon after Esc, or an embedded/sandboxed document). The game
    // stays playable without the lock, so swallow it rather than letting it
    // surface as an unhandled rejection.
    const p = this.canvas.requestPointerLock();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // Called each frame to smooth mouse & apply deadzone + recenter when no input
  update(dt) {
    // Publish this frame's key edges, then start collecting the next frame's.
    // Called before gameplay steps, so consumers see presses on the same frame.
    this.pressed = this._newPresses;
    this._newPresses = new Set();

    // Gentle auto-recenter when no movement (pointer lock gives no "release" event)
    // We rely on the fact that movementX/Y are 0 when mouse still, so nudge toward 0 slowly.
    this.mouseNX *= 0.985;
    this.mouseNY *= 0.985;

    // deadzone
    const apply = (v) => (Math.abs(v) < this.deadzone ? 0 : v);
    // Smooth toward target
    const k = 1 - Math.exp(-12 * dt);
    this.mouseX += (apply(this.mouseNX) - this.mouseX) * k;
    this.mouseY += (apply(this.mouseNY) - this.mouseY) * k;
  }
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
