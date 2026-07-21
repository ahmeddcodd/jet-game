// player.js — player jet controller: physics, controls, chase camera
import * as THREE from 'three';
import { createPlayerJet } from './models.js';
import { clamp, clamp01, damp, lerp, tmp, TAU } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

// Scratch for isTailedBy — it runs once per enemy per frame.
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _a1 = new THREE.Vector3();
const _a2 = new THREE.Vector3();
const _e1 = new THREE.Euler(0, 0, 0, 'YXZ');
const _dq = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/* ---------- Flight model ---------------------------------------------------
   An energy model rather than a "hold a direction and go" model. Speed is a
   consequence of thrust, the gravity component along the flight path, and drag
   — so diving builds energy, climbing spends it, and hard turns bleed it.
   That single change is what makes every BFM technique below actually mean
   something: a yo-yo trades altitude for turn rate, a break turn costs you the
   speed you need to escape, and an overshoot is something you can be forced
   into rather than a scripted event.                                        */
export const FLIGHT = {
  gravity: 34,          // units/s² — also the accel available along a vertical dive
  cornerSpeed: 115,     // speed of peak turn rate; below it lift limits you
  gLimit: 9,            // structural ceiling
  thrustMil: 62,        // military power
  thrustAB: 132,        // afterburner
  dragPara: 0.002025,   // parasitic ∝ v²  → ~175 top speed at mil, ~255 on burner
  dragInduced: 0.90,    // induced ∝ G²   → a sustained max-G turn out-drags mil power
  rollRate: 3.4,        // rad/s, roll is not G-limited
  rudderRate: 0.42,     // rad/s, weak on purpose — it's for nose authority, not turning
  stallSpeed: 42,       // below this the wing stops working
  minSpeed: 26,

  /* ---- Flight assist -----------------------------------------------------
     The energy model is what makes BFM meaningful, but on its own it also made
     the jet feel like it was fighting the player: pure bank-and-pull needs
     constant roll management, and G-limited pitch went vague at low speed.
     These terms sit on top of the physics rather than replacing it — the jet
     still bleeds speed in a turn and still can't out-pull its wing, it just
     stops punishing you for not flying it like a simulator.                */
  assistCoord: 0.80,    // bank alone pulls into the turn (coordinated-turn assist)
  assistYaw: 0.30,      // small rudder cross-feed for a tidy nose
  lowSpeedFloor: 0.22,  // floor under low-speed G so slow flight stays steerable
  pitchBoost: 1.30,     // overall pitch responsiveness
  // Mouse X commands a bank ANGLE the jet holds, rather than a roll rate that
  // keeps going until you counter it. You cannot accidentally roll inverted,
  // releasing returns to level, and combined with the coordinated-turn assist
  // it gives direct "point and go" steering. A/D still roll freely for
  // aerobatics and BFM, bypassing the hold entirely.
  maxBank: 1.30,        // radians (~75°) at full deflection
  bankGain: 3.2,        // how hard it drives toward the commanded bank
};

/* ---------- Assisted BFM maneuvers ----------------------------------------
   Each is a timed sequence of control deflections, so they run *through* the
   flight model rather than teleporting the jet: a Split-S really does convert
   altitude into speed, and an Immelmann really does bleed you. Every one of
   these is flyable by hand with roll + pitch — the keys just make the
   signature moves reliable to execute with a mouse.

   `pitch` +1 = full pull. `rollDirect` is body-axis roll, scaled by `dir`.  */
const MANEUVERS = {
  splitS: {
    name: 'SPLIT-S', key: 'KeyZ', minSpeed: 55, cooldown: 2.2,
    // Roll inverted, then pull through: reverses heading, trades altitude for speed.
    phases: [
      { until: 0.55, pitch: 0.05, rollDirect: 1.75 },
      { until: 2.10, pitch: 1.00, rollDirect: 0 },
    ],
  },
  immelmann: {
    name: 'IMMELMANN', key: 'KeyX', minSpeed: 105, cooldown: 2.4,
    // Pull up through a half loop then roll upright: reverses heading, buys
    // altitude with speed. Needs energy to start — that's the point.
    phases: [
      { until: 1.45, pitch: 1.00, rollDirect: 0 },
      { until: 2.05, pitch: 0.05, rollDirect: 1.7 },
    ],
  },
  barrelRoll: {
    name: 'BARREL ROLL', key: 'KeyC', minSpeed: 50, cooldown: 1.8,
    // Defensive: the classic way to force a closing attacker out in front.
    // Displaces the jet and scrubs speed without giving up much heading.
    phases: [
      { until: 1.60, pitch: 0.45, rollDirect: 1.9 },
    ],
  },
  breakTurn: {
    name: 'BREAK', key: 'KeyV', minSpeed: 40, cooldown: 1.5,
    // Max-G turn into the threat. Cheap to start, expensive in energy.
    phases: [
      { until: 0.30, pitch: 0.30, rollDirect: 2.2 },
      { until: 1.70, pitch: 1.00, rollDirect: 0 },
    ],
  },
};
const MANEUVER_LIST = Object.entries(MANEUVERS).map(([id, def]) => ({ id, ...def }));

export class Player {
  constructor(camera, input) {
    this.camera = camera;
    this.input = input;

    this.mesh = createPlayerJet();
    this.mesh.position.set(0, 120, 0);

    // Flight state
    this.speed = 95;             // current forward speed (units/s)
    this.throttle = 0.55;        // 0..1
    // Envelope reference points for HUD/camera normalisation. Actual speed is
    // an outcome of the energy model, not a clamp — a dive will exceed maxSpeed.
    this.minSpeed = FLIGHT.minSpeed;
    this.maxSpeed = 200;
    this.gLoad = 1;
    this.boost = 1.0;            // afterburner charge 0..1
    this.boostActive = false;

    // Active assisted maneuver + per-maneuver cooldowns
    this._maneuver = null;
    this._manCooldowns = new Map();
    this.onManeuver = null;      // hook for HUD callout

    // Steering angles (radians), smoothed
    this.pitch = 0;
    this.yaw = 0;
    this.roll = 0;
    this.targetPitch = 0;
    this.targetYaw = 0;
    this.targetRoll = 0;

    // World-space velocity, refreshed every frame. Enemy gun-lead prediction
    // reads this, so it has to be real velocity rather than just forward*speed
    // implied at the call site.
    this.velocity = new THREE.Vector3();

    // Health
    this.maxHealth = 100;
    this.health = 100;
    this.invuln = 0;             // seconds of invulnerability left
    this.alive = true;

    // Ammo
    this.missiles = 6;
    this.maxMissiles = 6;
    this.gunHeat = 0;
    this.missileCooldown = 0;

    // Countermeasures
    this.flares = 12;
    this.maxFlares = 12;
    this.flareCooldown = 0;
    this.onFlares = null;        // hook filled by the game

    // Weapons hooks (filled by game)
    this.onFireGun = null;
    this.onFireMissile = null;

    this._initCamera();
  }

  _initCamera() {
    // We control the camera each frame; start behind the jet
    const offset = new THREE.Vector3(0, 4.5, -16);
    this.cameraOffset = offset;
    this.camera.position.copy(this.mesh.position).add(offset);
    this.camera.lookAt(this.mesh.position);
    // Trauma-based shake: events add trauma, it decays continuously, and the
    // offset scales with trauma² so hits punch and then settle fast.
    this.trauma = 0;
    this._shakeTime = 0;
    this._camUp = new THREE.Vector3(0, 1, 0);
    this._lookTarget = new THREE.Vector3();
  }

  /** Add camera trauma (0..1). Overlapping events accumulate naturally. */
  addTrauma(amount) {
    this.trauma = clamp01(this.trauma + amount);
  }

  reset() {
    this.mesh.position.set(0, 140, 0);
    this.mesh.quaternion.identity();
    this.speed = 80;
    this.throttle = 0.55;
    this.boost = 1;
    this.health = this.maxHealth;
    this.invuln = 0;
    this.missiles = this.maxMissiles;
    this.flares = this.maxFlares;
    this.flareCooldown = 0;
    this.pitch = this.yaw = this.roll = 0;
    this.targetPitch = this.targetYaw = this.targetRoll = 0;
    this.velocity.set(0, 0, 0);
    this.trauma = 0;
    this.speed = 95;
    this.gLoad = 1;
    this._maneuver = null;
    this._manCooldowns.clear();
    this.alive = true;
    this.mesh.visible = true;
  }

  get forward() {
    return FWD.clone().applyQuaternion(this.mesh.quaternion);
  }
  get position() { return this.mesh.position; }

  /**
   * Is `enemy` sitting on our six and pointed at us? Drives the rear-threat
   * warning. Mirrors Enemy.isTailedBy so both sides of the fight use the same
   * definition of "being hunted".
   */
  isTailedBy(enemy, range = 420) {
    const toMe = _p1.copy(this.mesh.position).sub(enemy.position);
    const d = toMe.length();
    if (d > range || d < 1) return false;
    toMe.divideScalar(d);
    // The bandit is behind us: our nose points roughly along enemy->us.
    _p2.copy(FWD).applyQuaternion(this.mesh.quaternion);
    if (_p2.dot(toMe) < 0.30) return false;
    // ...and its nose is pointed at us.
    _p3.copy(FWD).applyQuaternion(enemy.mesh.quaternion);
    return _p3.dot(toMe) > 0.80;
  }

  /**
   * Begin an assisted BFM maneuver. Returns false if one is already running,
   * it's still cooling down, or there isn't enough energy to fly it — an
   * Immelmann at 60 knots should fail, not hang the jet in the vertical.
   */
  startManeuver(key, dir = 1) {
    const def = MANEUVERS[key];
    if (!def || this._maneuver) return false;
    if ((this._manCooldowns.get(key) || 0) > 0) return false;
    if (this.speed < def.minSpeed) {
      if (this.onManeuver) this.onManeuver(`${def.name} — NO ENERGY`, true);
      return false;
    }
    this._maneuver = { def, key, t: 0, dir: dir >= 0 ? 1 : -1 };
    if (this.onManeuver) this.onManeuver(def.name, false);
    return true;
  }

  get maneuverName() { return this._maneuver ? this._maneuver.def.name : null; }

  /** Drive the active maneuver; returns control deflections or null. */
  _updateManeuver(dt) {
    for (const [k, v] of this._manCooldowns) {
      if (v > 0) this._manCooldowns.set(k, v - dt);
    }
    const m = this._maneuver;
    if (!m) return null;
    m.t += dt;
    const phases = m.def.phases;
    const last = phases[phases.length - 1];
    if (m.t >= last.until) {
      this._manCooldowns.set(m.key, m.def.cooldown);
      this._maneuver = null;
      return null;
    }
    let phase = last;
    for (const p of phases) {
      if (m.t <= p.until) { phase = p; break; }
    }
    return {
      pitch: phase.pitch,
      roll: 0,
      rollDirect: phase.rollDirect * m.dir,
    };
  }

  damage(amount) {
    if (!this.alive || this.invuln > 0) return false;
    this.health = Math.max(0, this.health - amount);
    this.invuln = 0.6;
    this.addTrauma(0.30 + amount * 0.02);
    if (this.health <= 0) {
      this.alive = false;
      this.mesh.visible = false;
    }
    return true;
  }

  update(dt, t) {
    if (!this.alive) return;
    const inp = this.input;

    // ---- Throttle ----
    if (inp.keys.has('KeyW')) this.throttle = clamp01(this.throttle + dt * 0.5);
    if (inp.keys.has('KeyS')) this.throttle = clamp01(this.throttle - dt * 0.5);

    // ---- Afterburner ----
    this.boostActive = inp.keys.has('ShiftLeft') || inp.keys.has('ShiftRight');
    if (this.boostActive && this.boost > 0.02) {
      this.boost = clamp01(this.boost - dt * 0.35);
    } else {
      this.boostActive = false;
      this.boost = clamp01(this.boost + dt * 0.12);
    }

    // ---- Maneuver triggers ---------------------------------------------
    // Break rolls toward the way you're already leaning, so it turns into the
    // threat you were reacting to rather than away from it.
    for (const m of MANEUVER_LIST) {
      if (inp.pressed.has(m.key)) {
        const dir = m.id === 'breakTurn' ? (inp.mouseX >= 0 ? 1 : -1) : 1;
        this.startManeuver(m.id, dir);
      }
    }

    // ---- Control inputs -----------------------------------------------
    // A scripted BFM maneuver overrides the stick while it runs.
    const man = this._updateManeuver(dt);
    let mx = man ? man.roll : clamp(inp.mouseX, -1, 1);
    let my = man ? man.pitch : clamp(inp.mouseY, -1, 1);
    let rollIn = man ? man.rollDirect : 0;
    let yawIn = 0;
    // Keyboard flight: arrows mirror the mouse axes so the game is fully
    // playable without one, and A/D + Q/E stay available for fine control.
    let kx = 0, ky = 0;
    if (!man) {
      // Positive roll (about local +Z) lifts local +X, which is the screen-LEFT
      // wing — so positive roll banks toward screen right. A therefore needs the
      // negative direction to roll left.
      if (inp.keys.has('KeyA')) rollIn -= 1;
      if (inp.keys.has('KeyD')) rollIn += 1;
      if (inp.keys.has('KeyQ')) yawIn += 1;
      if (inp.keys.has('KeyE')) yawIn -= 1;
      if (inp.keys.has('ArrowLeft')) kx -= 1;
      if (inp.keys.has('ArrowRight')) kx += 1;
      if (inp.keys.has('ArrowUp')) ky -= 1;
      if (inp.keys.has('ArrowDown')) ky += 1;
    }

    // ---- Available G ---------------------------------------------------
    // Below corner speed the wing can't generate limit G (lift ∝ v²); above it
    // you're structurally capped. Turn rate = G·g/v therefore peaks exactly at
    // corner speed — the whole reason energy management matters.
    // Merge keyboard into the same axes as the mouse.
    if (kx) mx = clamp(mx + kx, -1, 1);
    if (ky) my = clamp(my - ky, -1, 1);

    const vRatio = this.speed / FLIGHT.cornerSpeed;
    // Keep a floor under low-speed authority. Physically the wing really does
    // run out of lift, but letting it go to zero just made slow flight feel
    // broken; the floor keeps the jet steerable while the turn *rate* still
    // collapses, so energy management is preserved.
    const liftG = FLIGHT.gLimit *
      Math.max(FLIGHT.lowSpeedFloor, Math.min(1, vRatio * vRatio));
    const stalled = this.speed < FLIGHT.stallSpeed;
    const authority = stalled ? Math.max(0.5, clamp01((this.speed - FLIGHT.minSpeed) / 16)) : 1;
    const availG = Math.min(FLIGHT.gLimit, liftG) * authority;

    // ---- Aircraft attitude ---------------------------------------------
    // HANDEDNESS — models are built forward = +Z, up = +Y. The chase camera
    // sits behind the jet looking along +Z, and a Three.js camera looks down
    // its own -Z, so it is turned 180° about Y relative to world axes and its
    // screen-right is world -X (measured, not assumed). So the model's local
    // +X is the jet's LEFT wing as the player sees it.
    const leftWingY = _a1.set(1, 0, 0).applyQuaternion(this.mesh.quaternion).y;
    const upY = _a2.set(0, 1, 0).applyQuaternion(this.mesh.quaternion).y;

    // bankAngle MUST be signed the same way as a positive this.roll. Roll is a
    // rotation about local +Z, which lifts local +X (the left wing) — so a
    // positive roll banks toward screen right, and atan2(leftWingY, upY) grows
    // positive with it. Sign this the other way and the bank-hold below flips
    // from negative to positive feedback: the jet rolls AWAY from the commanded
    // bank and accelerates into the 180° equilibrium, so the lightest touch on
    // the mouse ends with the aircraft locked inverted.
    const bankAngle = Math.atan2(leftWingY, upY);   // +ve = banked screen-right

    // Coordinated-turn assist. This is the key to "point and go": banking on
    // its own pulls the nose around, the way a pilot feeds in back-pressure
    // through a turn. Without it, mouse X only rolled the jet — and because
    // yaw is a body axis, once rolled it stopped being a heading change at all,
    // so the jet banked beautifully and flew straight on.
    const coord = !man && upY > 0.2
      ? Math.abs(clamp(leftWingY, -1, 1)) * FLIGHT.assistCoord
      : 0;

    // Commanded G: player pull plus the coordinated component.
    const pullIn = clamp01(Math.abs(my) + coord);
    const cmdG = pullIn * availG;
    this.gLoad = damp(this.gLoad, 1 + cmdG, 7, dt);

    // Pitch always pulls toward the aircraft's "up" when the assist is driving
    // it; explicit stick input still wins its own direction.
    const pitchSign = Math.abs(my) > 0.05 ? -Math.sign(my) : -1;
    const pitchRate = pitchSign *
      (cmdG * FLIGHT.gravity * FLIGHT.pitchBoost) / Math.max(this.speed, 24);

    // Roll: free rate under A/D or during a scripted maneuver, otherwise the
    // mouse holds a bank angle. atan2 measures bank continuously through
    // inverted, so releasing recovers from any attitude by the shorter way
    // round instead of leaving the jet stuck upside down.
    let rollRate;
    if (man || rollIn) {
      rollRate = ((man ? man.rollDirect : 0) + rollIn) * FLIGHT.rollRate * authority;
    } else {
      // Proportional hold on bank angle. bankAngle and rollRate share a sign
      // convention, so this is negative feedback: the error shrinks as the jet
      // reaches the commanded bank and holds there. Because atan2 wraps at
      // ±180°, releasing the mouse while inverted rolls upright the short way
      // round rather than stalling upside down.
      const bankWant = mx * FLIGHT.maxBank;
      rollRate = clamp((bankWant - bankAngle) * FLIGHT.bankGain,
                       -FLIGHT.rollRate, FLIGHT.rollRate) * authority;
    }
    const yawRate = (-mx * FLIGHT.assistYaw + yawIn * 0.6) * FLIGHT.rudderRate * authority;

    const resp = 8.5;
    this.pitch = damp(this.pitch, pitchRate, resp, dt);
    this.yaw   = damp(this.yaw, yawRate, resp, dt);
    this.roll  = damp(this.roll, rollRate, resp * 1.3, dt);

    // ---- Apply rotation in local space ----
    _e1.set(this.pitch * dt, this.yaw * dt, this.roll * dt, 'YXZ');
    _dq.setFromEuler(_e1);
    this.mesh.quaternion.multiply(_dq).normalize();

    const fwd = this.forward;

    // ---- Energy -------------------------------------------------------
    // Thrust - gravity along the flight path - (parasitic + induced) drag.
    const thrust = this.boostActive
      ? FLIGHT.thrustAB
      : lerp(FLIGHT.thrustMil * 0.15, FLIGHT.thrustMil, this.throttle);
    const gravityAccel = -FLIGHT.gravity * fwd.y;          // climbing costs, diving pays
    const drag = FLIGHT.dragPara * this.speed * this.speed
               + FLIGHT.dragInduced * this.gLoad * this.gLoad;
    this.speed = Math.max(FLIGHT.minSpeed, this.speed + (thrust + gravityAccel - drag) * dt);

    // Departure: with no airflow the nose falls through regardless of stick.
    if (stalled) {
      _axis.set(1, 0, 0).applyQuaternion(this.mesh.quaternion);
      const drop = (1 - this.speed / FLIGHT.stallSpeed) * 0.9 * dt;
      _dq.setFromAxisAngle(_axis, -drop * Math.sign(fwd.y || 1));
      this.mesh.quaternion.premultiply(_dq).normalize();
    }

    // ---- Move forward ----
    this.velocity.copy(fwd).multiplyScalar(this.speed);
    this.mesh.position.addScaledVector(fwd, this.speed * dt);

    // Soft ceiling & floor
    if (this.mesh.position.y > 900) this.mesh.position.y = 900;
    if (this.mesh.position.y < 20) {
      this.mesh.position.y = 20;
      // nudge nose up
      const fix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.6 * dt);
      this.mesh.quaternion.multiply(fix);
    }

    // Stay in world bounds: bank back toward center if too far
    const distFromCenter = Math.hypot(this.mesh.position.x, this.mesh.position.z);
    const BOUND = 2400;
    if (distFromCenter > BOUND) {
      const back = tmp.v1.set(-this.mesh.position.x, 0, -this.mesh.position.z).normalize();
      const curFwdFlat = tmp.v2.copy(fwd).setY(0).normalize();
      const cross = tmp.v3.crossVectors(curFwdFlat, back).y;
      const turn = clamp(cross, -1, 1) * 0.6 * dt;
      const bankBack = new THREE.Quaternion().setFromAxisAngle(UP, turn);
      this.mesh.quaternion.premultiply(bankBack).normalize();
    }

    // ---- Cooldowns ----
    if (this.invuln > 0) this.invuln -= dt;
    if (this.missileCooldown > 0) this.missileCooldown -= dt;
    if (this.gunHeat > 0) this.gunHeat -= dt * 2;
    if (this.flareCooldown > 0) this.flareCooldown -= dt;

    // ---- Countermeasures ----
    if (inp.pressed.has('Space') && this.onFlares) this.onFlares();

    // ---- Weapons ----
    if (inp.mouseDown && this.gunHeat <= 0 && this.onFireGun) {
      this.onFireGun();
      this.gunHeat = 0.085;
    }
    if ((inp.mouseDown2 || inp.keys.has('KeyF')) && this.missileCooldown <= 0 && this.missiles > 0 && this.onFireMissile) {
      this.onFireMissile();
      this.missiles--;
      this.missileCooldown = 0.6;
    }

    // ---- Afterburner ---------------------------------------------------
    // Throttle sets the base plume; the burner roughly doubles it. Each stage
    // flickers on its own incommensurate frequencies so the exhaust never
    // visibly loops, and the core shifts from orange at idle to blue-white on
    // the burner — the colour cue does most of the work at a glance.
    const heat = clamp01(this.throttle * 0.55 + (this.boostActive ? clamp01(this.boost) * 0.75 : 0));
    const stages = this.mesh.userData.flameStages || [];
    for (const stack of stages) {
      for (const st of stack) {
        // Two detuned sines + a fast tremor: combustion roughness, not a pulse.
        const flick = 1
          + Math.sin(t * 31.0 + st.phase) * 0.10
          + Math.sin(t * 17.3 + st.phase * 1.7) * 0.07
          + Math.sin(t * 71.0 + st.phase * 0.3) * 0.04;
        const len = (0.25 + heat * 2.9) * st.lenMul * flick;
        const wid = (0.55 + heat * 0.75) * st.widthMul * (1 + (flick - 1) * 0.45);
        st.mesh.visible = heat > 0.02;
        st.mesh.scale.set(wid, wid, Math.max(0.02, len));
        st.mat.opacity = clamp01(heat * st.intensity * 0.85 * flick);
        // Colour holds orange right through military power and only shifts
        // blue-white in the burner band — a linear ramp passed through green,
        // which no exhaust has ever done.
        const hb = clamp01((heat - 0.52) * 2.4);
        const hue = lerp(0.075, st.hue, hb);
        st.mat.color.setHSL(hue, lerp(0.95, 0.5, hb), lerp(0.45, 0.8, hb));
      }
    }

    const gl = this.mesh.userData.engineGlows || [];
    const glowPulse = 1 + Math.sin(t * 26 + 0.7) * 0.12;
    for (const g of gl) {
      g.material.color.setHSL(lerp(0.075, 0.55, clamp01((heat - 0.52) * 2.4)), 0.85, 0.35 + heat * 0.45);
      g.material.opacity = clamp01(0.35 + heat * 0.65) * glowPulse;
      const s = (0.8 + heat * 0.7) * glowPulse;
      g.scale.set(s, s, 1);
    }

    const nav = this.mesh.userData.navLights || [];
    for (const n of nav) {
      const k = 0.5 + 0.5 * Math.sin(t * 6 + n.blink);
      n.mesh.material.emissiveIntensity = 0.3 + k * 0.9;
    }

    // ---- Chase camera ----
    this._updateCamera(dt);
  }

  /**
   * Chase camera.
   *
   * Four things do the heavy lifting for chase feel:
   *  - the rig trails *softer* the faster you go, so it swings wide through
   *    turns instead of staying welded behind the tail;
   *  - it banks partially with the jet, so a roll actually reads as a roll
   *    while the horizon stays legible;
   *  - the look-at point runs ahead proportional to speed, which puts whatever
   *    you are chasing in frame rather than your own tailpipe;
   *  - FOV opens with speed and afterburner to sell velocity.
   */
  _updateCamera(dt) {
    const cam = this.camera;
    const q = this.mesh.quaternion;
    const fwd = tmp.v1.copy(FWD).applyQuaternion(q);
    const up = tmp.v2.copy(UP).applyQuaternion(q);
    const speedT = clamp01((this.speed - this.minSpeed) / (this.maxSpeed - this.minSpeed));

    // Sit further back and a touch higher as speed builds. Kept tight so the
    // jet actually fills the frame.
    const dist = 12.0 + speedT * 3.0 + (this.boostActive ? 1.8 : 0);
    const height = 3.4 + speedT * 0.9;
    const desired = tmp.v3.copy(this.mesh.position)
      .addScaledVector(fwd, -dist)
      .addScaledVector(up, height);

    // Carry the camera along with the jet BEFORE damping. Exponential damping
    // toward a moving target leaves a steady-state error of roughly
    // speed / follow-rate — at 130 u/s that pushed the camera to 42 units back
    // when the rig asked for 20, shrinking the jet to a dot. Advancing by the
    // jet's own velocity first means the damping only has to correct genuine
    // error, so the framing holds at any speed while still swinging in turns.
    cam.position.addScaledVector(this.velocity, dt);

    const follow = 7.0 - speedT * 2.2;
    cam.position.lerp(desired, 1 - Math.exp(-follow * dt));

    // Hard maneuvering swings the desired position around fast enough that the
    // damped rig can end up almost on top of the jet — measured at 4 units
    // during a loop, well inside the ~10-unit airframe, so the camera clips
    // through the model. Push it back out along the jet-to-camera line.
    const MIN_DIST = 8.5;
    const gap = tmp.v1.copy(cam.position).sub(this.mesh.position);
    const gapLen = gap.length();
    if (gapLen < MIN_DIST) {
      // Degenerate case: if the camera is exactly on the jet, fall back to
      // straight behind rather than normalising a zero-length vector.
      if (gapLen < 1e-3) gap.copy(fwd).multiplyScalar(-1);
      cam.position.copy(this.mesh.position).addScaledVector(gap.normalize(), MIN_DIST);
    }

    const targetFov = 62 + speedT * 16 + (this.boostActive ? 9 : 0);
    cam.fov = damp(cam.fov, targetFov, 3.5, dt);
    cam.updateProjectionMatrix();

    // Partial roll: blend world-up toward the jet's up so banking is felt but
    // the player never loses their sense of which way is down.
    this._camUp.copy(UP).lerp(up, 0.55).normalize();
    cam.up.copy(this._camUp);

    // Modest look-ahead: enough to put what you're chasing in frame, not so
    // much that the jet slides to the bottom edge.
    const lookAhead = 7 + speedT * 13;
    const lookAt = this._lookTarget.copy(this.mesh.position).addScaledVector(fwd, lookAhead);
    cam.lookAt(lookAt);

    this._applyShake(dt, cam);
  }

  /** Procedural trauma shake, applied after framing so it stays a pure offset. */
  _applyShake(dt, cam) {
    if (this.trauma <= 0) return;
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    this._shakeTime += dt;
    const s = this.trauma * this.trauma;   // squared falloff reads as a punch
    const t = this._shakeTime;
    // Incommensurate frequencies so the motion never visibly loops.
    cam.position.x += Math.sin(t * 47.3) * s * 1.9;
    cam.position.y += Math.sin(t * 39.7 + 1.7) * s * 1.9;
    cam.rotateZ(Math.sin(t * 43.1 + 3.1) * s * 0.055);
  }
}
