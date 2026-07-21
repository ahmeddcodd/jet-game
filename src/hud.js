// hud.js — heads-up display: health/throttle/boost bars, score, radar, messages,
// and the chase layer (target lock, lead reticle, off-screen arrows, rear threat).
const clampUnit = (v) => Math.max(-1, Math.min(1, v));

export class HUD {
  constructor() {
    this.el = document.getElementById('hud');
    this.tacticalCanvas = document.getElementById('tactical-canvas');
    this.tctx = this.tacticalCanvas ? this.tacticalCanvas.getContext('2d') : null;
    this.threatEl = document.getElementById('threat-warn');
    this.closureEl = document.getElementById('closure');
    this.missileWarnEl = document.getElementById('missile-warn');
    this.flareEl = document.getElementById('flare-count');
    this.gMeterEl = document.getElementById('g-meter');
    this.lockStateEl = document.getElementById('lock-state');
    this._threatPulse = 0;
    this.scoreEl = document.getElementById('score');
    this.waveEl = document.getElementById('wave');
    this.killsEl = document.getElementById('kills');
    this.healthFill = document.getElementById('health-fill');
    this.throttleFill = document.getElementById('throttle-fill');
    this.boostFill = document.getElementById('boost-fill');
    this.missileAmmo = document.getElementById('missile-ammo');
    this.centerMsg = document.getElementById('center-msg');
    this.hitmarker = document.getElementById('hitmarker');
    this.radar = document.getElementById('radar-canvas');
    this.rctx = this.radar.getContext('2d');

    this._msgTimer = 0;
  }
  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }

  setScore(v) { this.scoreEl.textContent = v.toLocaleString(); }
  setWave(v) { this.waveEl.textContent = v; }
  setKills(v) { this.killsEl.textContent = v; }

  setVitals(health, maxHealth, throttle, boost) {
    this.healthFill.style.width = `${(health / maxHealth) * 100}%`;
    this.throttleFill.style.width = `${throttle * 100}%`;
    this.boostFill.style.width = `${boost * 100}%`;
    // color health red when low
    const hp = health / maxHealth;
    if (hp < 0.3) this.healthFill.style.background = 'linear-gradient(90deg,#ff5b5b,#ff8a5b)';
    else this.healthFill.style.background = 'linear-gradient(90deg,#3affb0,#7fffd4)';
  }
  setMissiles(n) { this.missileAmmo.textContent = n; }

  message(text, sub = '', duration = 2.4) {
    this.centerMsg.innerHTML = `${text}${sub ? `<span class="sub">${sub}</span>` : ''}`;
    this.centerMsg.classList.add('show');
    this._msgTimer = duration;
  }

  hitMarker() {
    this.hitmarker.classList.remove('show');
    void this.hitmarker.offsetWidth; // restart animation
    this.hitmarker.classList.add('show');
  }

  // radar: player fwd + enemies list. Each enemy: {x,z,type,alive}
  drawRadar(playerPos, playerFwd, enemies, range = 1400) {
    const ctx = this.rctx;
    const W = this.radar.width, H = this.radar.height;
    const cx = W / 2, cy = H / 2, R = W / 2 - 4;
    ctx.clearRect(0, 0, W, H);

    // bg
    ctx.fillStyle = 'rgba(6,20,22,0.5)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // rings
    ctx.strokeStyle = 'rgba(127,255,212,0.25)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath(); ctx.arc(cx, cy, (R * i) / 3, 0, Math.PI * 2); ctx.stroke();
    }
    // crosshair
    ctx.beginPath();
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.stroke();

    // Sweep angle (rotating)
    const sweep = (performance.now() / 1000) % (Math.PI * 2);
    const grad = ctx.createConicGradient ? ctx.createConicGradient(sweep, cx, cy) : null;
    if (grad) {
      grad.addColorStop(0, 'rgba(127,255,212,0.35)');
      grad.addColorStop(0.08, 'rgba(127,255,212,0)');
      grad.addColorStop(1, 'rgba(127,255,212,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    }

    // World→radar transform: rotate so player forward points up.
    const angle = Math.atan2(playerFwd.x, playerFwd.z); // yaw
    const cos = Math.cos(-angle), sin = Math.sin(-angle);

    // enemies
    for (const e of enemies) {
      const dx = e.x - playerPos.x;
      const dz = e.z - playerPos.z;
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      const dist = Math.hypot(rx, rz);
      if (dist > range) continue;
      const px = cx + (rx / range) * R;
      const py = cy - (rz / range) * R;
      ctx.fillStyle = e.type === 'helo' ? '#ffcf5b' : '#ff5b5b';
      ctx.beginPath();
      if (e.type === 'helo') {
        ctx.fillRect(px - 3, py - 3, 6, 6);
      } else {
        ctx.moveTo(px, py - 4); ctx.lineTo(px + 4, py + 3); ctx.lineTo(px - 4, py + 3); ctx.closePath(); ctx.fill();
      }
    }

    // player arrow (center)
    ctx.fillStyle = '#7fffd4';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6); ctx.lineTo(cx + 4, cy + 4); ctx.lineTo(cx - 4, cy + 4); ctx.closePath(); ctx.fill();
  }

  /** Match the tactical overlay to the drawing buffer, accounting for DPR. */
  resizeTactical(w, h, dpr = Math.min(window.devicePixelRatio, 2)) {
    if (!this.tacticalCanvas) return;
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (this.tacticalCanvas.width === cw && this.tacticalCanvas.height === ch) return;
    this.tacticalCanvas.width = cw;
    this.tacticalCanvas.height = ch;
    this.tacticalCanvas.style.width = `${w}px`;
    this.tacticalCanvas.style.height = `${h}px`;
    this._dpr = dpr;
  }

  /**
   * Re-sync the overlay to the viewport if they have diverged.
   *
   * The canvas is stretched to the viewport by CSS but keeps its own pixel
   * grid, so if a resize is ever missed the overlay silently draws into the
   * wrong coordinate space — target boxes, lock reticle and stick indicator all
   * land in the wrong place. Cheap to check every frame; the setter above
   * no-ops unless the size actually changed.
   */
  syncTacticalSize() {
    this.resizeTactical(window.innerWidth, window.innerHeight);
  }

  /**
   * Chase overlay, drawn once per frame in screen space.
   *
   * `targets` entries: { pos: Vector3, type, hp01, locked, lead: Vector3|null,
   *                      dist, closure, onScreen, sx, sy, behind }
   * Screen projection is done by the caller (it already has the camera).
   */
  drawTactical(targets, threat) {
    const ctx = this.tctx;
    if (!ctx) return;
    const dpr = this._dpr || 1;
    const W = this.tacticalCanvas.width, H = this.tacticalCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.scale(dpr, dpr);
    const w = W / dpr, h = H / dpr;
    const cx = w / 2, cy = h / 2;

    for (const t of targets) {
      if (t.onScreen) {
        // Distance-scaled box so nearby bandits read as bigger threats.
        const size = Math.max(14, Math.min(74, 2600 / Math.max(t.dist, 1)));
        const half = size / 2;
        const locked = t.locked;
        ctx.strokeStyle = locked ? '#ff4d4d' : 'rgba(127,255,212,0.72)';
        ctx.lineWidth = locked ? 2 : 1.25;

        // Corner brackets rather than a full box — less occluding.
        const c = size * 0.28;
        ctx.beginPath();
        for (const [ox, oy, dx, dy] of [
          [-half, -half, 1, 1], [half, -half, -1, 1],
          [-half, half, 1, -1], [half, half, -1, -1],
        ]) {
          ctx.moveTo(t.sx + ox, t.sy + oy + dy * c);
          ctx.lineTo(t.sx + ox, t.sy + oy);
          ctx.lineTo(t.sx + ox + dx * c, t.sy + oy);
        }
        ctx.stroke();

        // Health pip under the box
        if (t.hp01 < 1) {
          const bw = size * 0.9;
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.fillRect(t.sx - bw / 2, t.sy + half + 5, bw, 3);
          ctx.fillStyle = t.hp01 < 0.35 ? '#ff5b5b' : '#ffcf5b';
          ctx.fillRect(t.sx - bw / 2, t.sy + half + 5, bw * t.hp01, 3);
        }

        // Lead reticle: where to put the pipper for a hit at current closure.
        if (locked && t.lead) {
          ctx.strokeStyle = '#ffe066';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(t.lead.x, t.lead.y, 7, 0, Math.PI * 2);
          ctx.moveTo(t.lead.x - 11, t.lead.y); ctx.lineTo(t.lead.x - 4, t.lead.y);
          ctx.moveTo(t.lead.x + 4, t.lead.y);  ctx.lineTo(t.lead.x + 11, t.lead.y);
          ctx.stroke();
          // Dotted tie-line from the target box to the lead point
          ctx.save();
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = 'rgba(255,224,102,0.5)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(t.sx, t.sy); ctx.lineTo(t.lead.x, t.lead.y);
          ctx.stroke();
          ctx.restore();

          ctx.fillStyle = '#ff4d4d';
          ctx.font = '600 11px ui-monospace,Menlo,monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`${Math.round(t.dist)}m`, t.sx, t.sy - half - 7);
        }
      } else {
        // Off-screen: arrow on the rim of a centered ellipse pointing at it.
        const ang = Math.atan2(t.sy - cy, t.sx - cx) + (t.behind ? Math.PI : 0);
        const rx = w * 0.36, ry = h * 0.36;
        const ax = cx + Math.cos(ang) * rx;
        const ay = cy + Math.sin(ang) * ry;
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(ang);
        ctx.fillStyle = t.locked ? 'rgba(255,77,77,0.9)' : 'rgba(127,255,212,0.55)';
        ctx.beginPath();
        ctx.moveTo(10, 0); ctx.lineTo(-6, 6); ctx.lineTo(-6, -6);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }

    // Rear-threat arc: a red wedge at the bottom when someone is on your six.
    if (threat && threat.active) {
      const a = 0.35 + 0.35 * Math.sin(this._threatPulse * 9);
      ctx.strokeStyle = `rgba(255,60,60,${a})`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(w, h) * 0.34, Math.PI * 0.28, Math.PI * 0.72);
      ctx.stroke();
    }
  }

  /**
   * Lock reticle: a shrinking dashed ring that closes onto the target as the
   * seeker acquires, then snaps to a solid diamond when the tone goes solid.
   * Drawn separately from the target boxes so it reads as its own event.
   */
  drawLock(state, progress, sx, sy, onScreen) {
    const ctx = this.tctx;
    if (!ctx || !onScreen || state === 'searching') return;
    const dpr = this._dpr || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    if (state === 'acquiring') {
      // Ring closes in from wide to tight as progress -> 1.
      const r = 62 - progress * 34;
      ctx.strokeStyle = `rgba(255,210,80,${0.45 + progress * 0.5})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 6]);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // Progress arc
      ctx.strokeStyle = '#ffd250';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sx, sy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
    } else {
      // Solid lock: diamond + corner ticks.
      ctx.strokeStyle = '#ff3b3b';
      ctx.lineWidth = 2.5;
      const r = 30;
      ctx.beginPath();
      ctx.moveTo(sx, sy - r); ctx.lineTo(sx + r, sy);
      ctx.lineTo(sx, sy + r); ctx.lineTo(sx - r, sy);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = '#ff3b3b';
      ctx.font = '700 12px ui-monospace,Menlo,monospace';
      ctx.textAlign = 'center';
      ctx.fillText('LOCK', sx, sy - r - 8);
    }
    ctx.restore();
  }

  setLockState(state, progress) {
    if (!this.lockStateEl) return;
    const label = state === 'locked' ? 'LOCK'
      : state === 'acquiring' ? `ACQ ${Math.round(progress * 100)}%`
      : 'SEARCH';
    this.lockStateEl.textContent = label;
    this.lockStateEl.className = state;
  }

  setMissileWarning(active) {
    if (!this.missileWarnEl) return;
    this.missileWarnEl.classList.toggle('show', !!active);
  }

  setFlares(n, max) {
    if (!this.flareEl) return;
    this.flareEl.textContent = n;
    this.flareEl.className = n === 0 ? 'empty' : (n <= max * 0.3 ? 'low' : '');
  }

  setG(g) {
    if (!this.gMeterEl) return;
    this.gMeterEl.textContent = `${g.toFixed(1)}G`;
    this.gMeterEl.className = g > 7.5 ? 'high' : (g > 5 ? 'mid' : '');
  }

  /**
   * Virtual stick position, drawn as a small box below the crosshair.
   *
   * Pointer lock hides the cursor, so without this the player is flying an
   * invisible self-centring stick with no way to know what they are currently
   * commanding — the single biggest reason the controls read as unpredictable.
   * Seeing the input makes the response learnable.
   */
  drawStick(x, y) {
    const ctx = this.tctx;
    if (!ctx) return;
    const dpr = this._dpr || 1;
    const w = this.tacticalCanvas.width / dpr;
    const h = this.tacticalCanvas.height / dpr;
    // Bottom-centre. Sitting just under the crosshair put this squarely on top
    // of the aircraft; down here it is still glanceable without occluding it,
    // and it reads naturally as a stick position.
    const cx = w / 2, cy = h - 58;
    const R = 26;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    // Frame + centre ticks
    ctx.strokeStyle = 'rgba(127,255,212,0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - R, cy - R, R * 2, R * 2);
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy); ctx.lineTo(cx + 4, cy);
    ctx.moveTo(cx, cy - 4); ctx.lineTo(cx, cy + 4);
    ctx.stroke();

    // Commanded position. Screen Y already matches stick sense: mouse down
    // (pull, nose up) is +y here and draws the dot low, like a real stick.
    const px = cx + clampUnit(x) * R;
    const py = cy + clampUnit(y) * R;
    const active = Math.abs(x) > 0.02 || Math.abs(y) > 0.02;
    ctx.strokeStyle = active ? 'rgba(127,255,212,0.85)' : 'rgba(127,255,212,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(px, py);
    ctx.stroke();
    ctx.fillStyle = active ? '#7fffd4' : 'rgba(127,255,212,0.45)';
    ctx.beginPath();
    ctx.arc(px, py, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Avionics HUD — pitch ladder, heading tape, speed/altitude, flight-path
   * marker, bank scale.
   *
   * Every symbol that represents a direction in the world is drawn by
   * PROJECTING an actual 3D direction through the camera, never by offsetting
   * pixels from screen centre. That is what makes it correct rather than
   * approximate: the ladder ends up at the true horizon, rotates properly with
   * bank, compresses correctly toward the edges of the frame, and stays right
   * when the FOV changes with speed — none of which a pixels-per-degree
   * approximation gets for free.
   *
   * `av` supplies the already-projected points (see buildAvionics in main.js),
   * so this function stays pure drawing.
   */
  drawAvionics(av) {
    const ctx = this.tctx;
    if (!ctx || !av) return;
    const dpr = this._dpr || 1;
    const w = this.tacticalCanvas.width / dpr;
    const h = this.tacticalCanvas.height / dpr;
    const cx = w / 2, cy = h / 2;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 1.4;
    ctx.font = '600 11px ui-monospace,Menlo,monospace';
    ctx.textBaseline = 'middle';
    const GREEN = 'rgba(126,255,178,0.92)';
    const DIM = 'rgba(126,255,178,0.45)';
    ctx.strokeStyle = GREEN;
    ctx.fillStyle = GREEN;

    // Clip everything to the glass area so symbology never spills over the
    // coaming or off the canopy.
    ctx.beginPath();
    ctx.rect(w * 0.13, h * 0.06, w * 0.74, h * 0.66);
    ctx.clip();

    // ---- Pitch ladder ---------------------------------------------------
    for (const r of av.rungs) {
      const { a, b, deg } = r;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (!len) continue;
      const ux = dx / len, uy = dy / len;
      const gap = deg === 0 ? 0.30 : 0.22;   // horizon bar has a wider break

      ctx.setLineDash(deg < 0 ? [7, 5] : []);   // dive bars dashed, per convention
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x + ux * len * (0.5 - gap / 2), a.y + uy * len * (0.5 - gap / 2));
      ctx.moveTo(a.x + ux * len * (0.5 + gap / 2), a.y + uy * len * (0.5 + gap / 2));
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      // Tips turn toward the horizon so up/down is unambiguous when inverted.
      if (deg !== 0) {
        const tick = deg > 0 ? 7 : -7;
        const nx = -uy, ny = ux;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + nx * tick, a.y + ny * tick);
        ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + nx * tick, b.y + ny * tick);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      if (deg !== 0) {
        const label = String(Math.abs(deg));
        ctx.save();
        ctx.translate(a.x - ux * 13, a.y - uy * 13);
        ctx.rotate(Math.atan2(uy, ux));
        ctx.textAlign = 'center';
        ctx.fillText(label, 0, 0);
        ctx.restore();
        ctx.save();
        ctx.translate(b.x + ux * 13, b.y + uy * 13);
        ctx.rotate(Math.atan2(uy, ux));
        ctx.textAlign = 'center';
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }

    // ---- Flight-path marker ---------------------------------------------
    // Where the aircraft is actually GOING, as opposed to where the nose
    // points. On a real HUD this is the symbol you fly with.
    if (av.fpm) {
      const { x, y } = av.fpm;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.moveTo(x - 7, y);  ctx.lineTo(x - 17, y);
      ctx.moveTo(x + 7, y);  ctx.lineTo(x + 17, y);
      ctx.moveTo(x, y - 7);  ctx.lineTo(x, y - 14);
      ctx.stroke();
      ctx.lineWidth = 1.4;
    }

    // ---- Gunsight -------------------------------------------------------
    // A pipper you can actually aim with: a ranging ring, a bright centre dot,
    // and four ticks. Drawn brighter than the ladder because it is the thing
    // you put on the target, and the previous faint cross vanished against
    // terrain. Turns red and grows a lock ring when a target is locked.
    const locked = !!av.gunLocked;
    ctx.strokeStyle = locked ? 'rgba(255,90,90,0.95)' : 'rgba(150,255,200,0.95)';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - 26, cy); ctx.lineTo(cx - 16, cy);
    ctx.moveTo(cx + 16, cy); ctx.lineTo(cx + 26, cy);
    ctx.moveTo(cx, cy - 26); ctx.lineTo(cx, cy - 16);
    ctx.moveTo(cx, cy + 16); ctx.lineTo(cx, cy + 26);
    ctx.stroke();
    if (locked) {
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, 23, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = GREEN;
    ctx.fillStyle = GREEN;

    ctx.restore();

    // ---- Tapes and readouts (outside the glass clip) ---------------------
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.font = '600 11px ui-monospace,Menlo,monospace';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = GREEN;
    ctx.fillStyle = GREEN;
    ctx.lineWidth = 1.3;

    // Heading tape across the top, ticks placed by projected compass bearings.
    const tapeY = h * 0.115;
    ctx.beginPath();
    ctx.moveTo(w * 0.30, tapeY + 9); ctx.lineTo(w * 0.70, tapeY + 9);
    ctx.stroke();
    ctx.textAlign = 'center';
    for (const t of av.headings) {
      if (t.x < w * 0.30 || t.x > w * 0.70) continue;
      ctx.beginPath();
      ctx.moveTo(t.x, tapeY + 9);
      ctx.lineTo(t.x, tapeY + (t.major ? 1 : 5));
      ctx.stroke();
      if (t.major) ctx.fillText(t.label, t.x, tapeY - 8);
    }
    // Own-heading caret
    ctx.beginPath();
    ctx.moveTo(cx, tapeY + 15); ctx.lineTo(cx - 5, tapeY + 22); ctx.lineTo(cx + 5, tapeY + 22);
    ctx.closePath(); ctx.fill();
    ctx.fillText(av.headingText, cx, tapeY + 32);

    // Airspeed (left) and altitude (right) boxes.
    const boxY = cy;
    const drawBox = (x, align, label, value, sub) => {
      const bw = 74, bh = 30;
      const bx = align === 'left' ? x : x - bw;
      ctx.strokeRect(bx, boxY - bh / 2, bw, bh);
      ctx.textAlign = 'center';
      ctx.font = '700 15px ui-monospace,Menlo,monospace';
      ctx.fillText(value, bx + bw / 2, boxY);
      ctx.font = '600 9px ui-monospace,Menlo,monospace';
      ctx.fillStyle = DIM;
      ctx.fillText(label, bx + bw / 2, boxY - bh / 2 - 8);
      if (sub) ctx.fillText(sub, bx + bw / 2, boxY + bh / 2 + 9);
      ctx.fillStyle = GREEN;
    };
    drawBox(w * 0.20, 'left', 'SPD', String(av.speed), av.mach);
    drawBox(w * 0.80, 'right', 'ALT', String(av.alt), av.gText);

    // Bank scale — fixed arc with a moving pointer, the standard arrangement.
    const bankR = Math.min(w, h) * 0.30;
    ctx.strokeStyle = DIM;
    for (const d of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
      const a = -Math.PI / 2 + d * Math.PI / 180;
      const r0 = bankR, r1 = bankR + (d === 0 ? 10 : 6);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }
    const ba = -Math.PI / 2 - av.bankRad;
    ctx.fillStyle = GREEN;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ba) * (bankR - 2), cy + Math.sin(ba) * (bankR - 2));
    ctx.lineTo(cx + Math.cos(ba - 0.035) * (bankR - 11), cy + Math.sin(ba - 0.035) * (bankR - 11));
    ctx.lineTo(cx + Math.cos(ba + 0.035) * (bankR - 11), cy + Math.sin(ba + 0.035) * (bankR - 11));
    ctx.closePath(); ctx.fill();

    ctx.restore();
  }

  /** Transient score popup near the crosshair. Recycled, never accumulates. */
  floatScore(text, big = false) {
    if (!this.el) return;
    const el = document.createElement('div');
    el.className = `float-score${big ? ' big' : ''}`;
    el.textContent = text;
    el.style.left = `${48 + Math.random() * 4}%`;
    this.el.appendChild(el);
    // Self-removing so the HUD never grows unbounded during a long run.
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 2000);
  }

  /** Pulsing red vignette when the hull is critical. */
  setCritical(active) {
    if (!this.el) return;
    this.el.classList.toggle('critical', !!active);
  }

  setThreat(active, dist) {
    if (!this.threatEl) return;
    this.threatEl.classList.toggle('show', !!active);
    if (active) this.threatEl.textContent = `⚠ THREAT ${Math.round(dist)}m`;
  }

  /** Closure rate on the locked target: + is closing, − is opening. */
  setClosure(closure, hasTarget) {
    if (!this.closureEl) return;
    if (!hasTarget) { this.closureEl.textContent = '—'; this.closureEl.className = ''; return; }
    const v = Math.round(closure);
    this.closureEl.textContent = `${v >= 0 ? '+' : ''}${v}`;
    this.closureEl.className = v >= 0 ? 'closing' : 'opening';
  }

  update(dt) {
    this._threatPulse += dt;
    if (this._msgTimer > 0) {
      this._msgTimer -= dt;
      if (this._msgTimer <= 0) this.centerMsg.classList.remove('show');
    }
  }
}
