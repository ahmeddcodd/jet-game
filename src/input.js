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

    /* ---- Virtual stick tuning ------------------------------------------
       Mouse motion accumulates into a virtual stick position (mouseNX/NY,
       clamped to +/-1) which the flight model reads as a commanded bank angle
       and G. Two properties matter for this to feel accurate:

       - Everything is per SECOND, never per frame. The old auto-centre was
         `mouseNX *= 0.985` once per frame, so after holding the mouse still
         for one second the surviving command was 0.66 at 30fps but 0.01 at
         240fps — a 73x swing in control feel purely from frame rate.
       - The return to centre is LINEAR, not exponential. Exponential decay
         approaches zero asymptotically without reaching it, so a residual
         command always lingers and the jet drifts; that residue was what the
         old snapping deadzone existed to paper over. A constant rate actually
         arrives at zero, which removes both the drift and the need for a
         deadband — so small, precise corrections now register instead of
         being swallowed.                                                   */
    this.sensitivity = 0.0022;   // stick units per pixel of mouse movement
    this.returnRate = 0.40;      // stick units per second back toward centre
    this.smoothing = 14;         // command follow rate (1/s)

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
        // Clear the smoothed command too — leaving it set meant the jet kept
        // turning for a moment after the pointer was released.
        this.mouseNX = 0; this.mouseNY = 0;
        this.mouseX = 0; this.mouseY = 0;
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

  /** Move a value toward zero at a fixed rate, landing exactly on zero. */
  static _toZero(v, step) {
    if (v > step) return v - step;
    if (v < -step) return v + step;
    return 0;
  }

  // Called each frame: recentre the virtual stick, then smooth the command.
  update(dt) {
    // Publish this frame's key edges, then start collecting the next frame's.
    // Called before gameplay steps, so consumers see presses on the same frame.
    this.pressed = this._newPresses;
    this._newPresses = new Set();

    // Pointer lock gives no "mouse released" event, so the stick eases back to
    // neutral on its own. Rate is per second, so the feel is identical at any
    // frame rate, and it reaches true zero so the jet stops turning completely
    // instead of creeping.
    const step = this.returnRate * dt;
    this.mouseNX = Input._toZero(this.mouseNX, step);
    this.mouseNY = Input._toZero(this.mouseNY, step);

    // Smooth the command toward the stick position (already frame-rate correct).
    const k = 1 - Math.exp(-this.smoothing * dt);
    this.mouseX += (this.mouseNX - this.mouseX) * k;
    this.mouseY += (this.mouseNY - this.mouseY) * k;
  }
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
