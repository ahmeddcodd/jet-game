// player.js — player jet controller: physics, controls, chase camera
import * as THREE from 'three';
import { createPlayerJet } from './models.js';
import { clamp, clamp01, damp, lerp, tmp, TAU } from './utils.js';
import { ENVELOPE, createFlightState, integrate } from './flight.js';
import { EYE_OFFSET } from './cockpit.js';

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

// Scratch for isTailedBy — it runs once per enemy per frame.
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _a1 = new THREE.Vector3();
const _a2 = new THREE.Vector3();
// Camera-only scratch. _updateCamera holds `fwd`/`up`/`desired` in tmp.v1-v3
// across the whole function, so anything else in there needs its own storage —
// reusing tmp.v1 for a guard silently corrupted the forward vector that the
// final lookAt depends on.
const _camGap = new THREE.Vector3();
const _camOff = new THREE.Vector3();
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
   into rather than a scripted event.

   The envelope itself lives in flight.js and is SHARED with the AI, so both
   aircraft obey identical limits. Only the assist layer — the things a human
   flying with a mouse needs and an AI does not — is defined here.           */
export const FLIGHT = {
  ...ENVELOPE,
  rudderRate: 0.42,     // rad/s, weak on purpose — nose authority, not turning

  /* ---- Flight assist -----------------------------------------------------
     The energy model is what makes BFM meaningful, but on its own it also made
     the jet feel like it was fighting the player: pure bank-and-pull needs
     constant roll management, and G-limited pitch went vague at low speed.
     These terms sit on top of the physics rather than replacing it — the jet
     still bleeds speed in a turn and still can't out-pull its wing, it just
     stops punishing you for not flying it like a simulator.                */
  // Gain on the coordinated turn rate. 1.0 would be the literal g·tan(φ)/V
  // relation; above that trades some realism for arcade responsiveness.
  assistCoord: 1.45,
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
    // Timings are derived from the measured model, not guessed: a 180° roll at
    // rate 1.75 takes 1.02/1.75 ≈ 0.58 s, and a 180° pull takes ≈ 1.20 s. The
    // old 1.55 s pull carried the jet 29% past vertical, so the Split-S came
    // out the far side still climbing — it gained altitude instead of trading it.
    phases: [
      { until: 0.58, pitch: 0.05, rollDirect: 1.75 },
      { until: 1.78, pitch: 1.00, rollDirect: 0 },
      { until: 2.45, pitch: 0.00, level: true },
    ],
  },
  immelmann: {
    name: 'IMMELMANN', key: 'KeyX', minSpeed: 105, cooldown: 2.4,
    // Pull up through a half loop then roll upright: reverses heading, buys
    // altitude with speed. Needs energy to start — that's the point.
    // 1.26 s for the half loop (measured 1.25 s at this entry speed), then
    // 1.02/1.7 ≈ 0.60 s to roll upright.
    phases: [
      { until: 1.26, pitch: 1.00, rollDirect: 0 },
      { until: 1.88, pitch: 0.05, rollDirect: 1.7 },
      { until: 2.50, pitch: 0.00, level: true },
    ],
  },
  barrelRoll: {
    name: 'BARREL ROLL', key: 'KeyB', minSpeed: 50, cooldown: 1.8,
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
      { until: 2.20, pitch: 0.00, level: true },
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
    // Shared flight state — the same structure the AI flies (see flight.js).
    this.fs = createFlightState(this.speed);
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
    this.cockpitView = false;      // false = chase, true = first person
    this.onViewChange = null;
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
    this.fs.speed = 95; this.fs.gLoad = 1;
    this.fs.pitch = this.fs.yaw = this.fs.roll = 0;
    this._maneuver = null;
    this._manCooldowns.clear();
    this.alive = true;
    // Respect the current view: showing the external hull unconditionally
    // would pop the fuselage into frame on respawn while in the cockpit.
    this.mesh.visible = !this.cockpitView;
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
      rollDirect: (phase.rollDirect || 0) * m.dir,
      // A levelling phase hands roll back to the bank hold, which rolls the
      // wings level from ANY attitude. Open-loop timings alone cannot promise
      // that: the aircraft slows through a reversal, which changes both the
      // pitch and roll it achieves, so a Split-S could finish inverted.
      level: !!phase.level,
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

    // ---- Fly it ---------------------------------------------------------
    // One integrate() call, the SAME one the enemy AI uses (see flight.js).
    // Everything above this line is the assist layer — turning mouse and
    // keyboard into stick commands. Below it, the player's jet is subject to
    // exactly the envelope the bandits are: lift-limited G, a coordinated turn
    // about the world vertical, and speed as an outcome of thrust, gravity
    // along the flight path and drag. Neither side can out-fly the other's
    // physics, which is what makes the fight legible.
    integrate(this.mesh, this.fs, {
      // Mouse X holds a bank angle; A/D and scripted maneuvers roll freely.
      bank: (man && man.level) ? 0 : mx * FLIGHT.maxBank,
      // null = use the bank hold. A running maneuver always takes rate control,
      // even when its current phase commands rate 0 (hold this attitude).
      freeRoll: (man && man.level) ? null
              : (man || rollIn) ? ((man ? man.rollDirect : 0) + rollIn) : null,
      pitch: my,
      yaw: yawIn * 0.6,
      throttle: this.throttle,
      boost: this.boostActive,
      // A scripted maneuver is flown on raw roll and pitch; letting the
      // coordinated turn also act would fight the choreography.
      noCoordTurn: !!man,
    }, dt);

    // Mirror onto the fields the rest of the game reads.
    this.speed = this.fs.speed;
    this.gLoad = this.fs.gLoad;
    this.pitch = this.fs.pitch;
    this.yaw = this.fs.yaw;
    this.roll = this.fs.roll;

    const fwd = this.forward;

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
      // Scale from ZERO with throttle. A fixed 0.35 floor meant the exhaust
      // disc glowed even with the engine idle, so the nozzle never read as an
      // unlit opening.
      g.material.opacity = clamp01(heat * 1.15) * glowPulse;
      const s = (0.8 + heat * 0.7) * glowPulse;
      g.scale.set(s, s, 1);
    }

    const nav = this.mesh.userData.navLights || [];
    for (const n of nav) {
      const k = 0.5 + 0.5 * Math.sin(t * 6 + n.blink);
      n.mesh.material.emissiveIntensity = 0.3 + k * 0.9;
    }

    // ---- Camera ----
    if (inp.pressed.has('KeyC')) {
      this.cockpitView = !this.cockpitView;
      if (this.onViewChange) this.onViewChange(this.cockpitView);
    }
    if (this.cockpitView) this._updateCockpitCamera(dt);
    else this._updateCamera(dt);
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
  /**
   * Cockpit camera: rigidly locked to the airframe at the pilot's eye point.
   *
   * No damping and no look-ahead, deliberately. Those exist to make a chase rig
   * feel weighty, but a pilot's head does not lag their aircraft — any smoothing
   * here would read as the cockpit sliding around you. Trauma shake still
   * applies, and because the interior is parented to the camera it shakes with
   * the view rather than against it.
   */
  _updateCockpitCamera(dt) {
    const cam = this.camera;
    const q = this.mesh.quaternion;
    cam.quaternion.copy(q);
    // The model faces +Z but a three camera looks down -Z, so the view has to
    // be turned to face the way the aircraft is pointing.
    cam.rotateY(Math.PI);
    cam.position.copy(this.mesh.position)
      .add(tmp.v1.copy(EYE_OFFSET).applyQuaternion(q));
    cam.up.set(0, 1, 0).applyQuaternion(q);

    const speedT = clamp01((this.speed - this.minSpeed) / (this.maxSpeed - this.minSpeed));
    const targetFov = 68 + speedT * 10 + (this.boostActive ? 6 : 0);
    cam.fov = damp(cam.fov, targetFov, 3.5, dt);
    // The interior sits well inside the chase view's 2.0 near plane, so it
    // would be clipped away entirely. Pulling the near plane in is safe here
    // only because the renderer uses a logarithmic depth buffer, which spreads
    // precision across the range instead of spending it all up close.
    if (cam.near !== 0.12) { cam.near = 0.12; }
    cam.updateProjectionMatrix();

    this._applyShake(dt, cam);
  }

  _updateCamera(dt) {
    const cam = this.camera;
    if (cam.near !== 2.0) { cam.near = 2.0; cam.updateProjectionMatrix(); }
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

    // Keep the rig behind the jet and clear of the airframe.
    //
    // Both guards below correct along the DESIRED offset direction, never the
    // camera's current one. Clamping along the current direction is a trap: if
    // the rig ever drifts in front of the jet, the clamp pins it out there and
    // re-pins it every frame, while the damped follow can only claw back a few
    // percent per frame — so it stays stuck ahead, looking away, and the jet is
    // never on screen.
    _camOff.copy(desired).sub(this.mesh.position);
    if (_camOff.lengthSq() < 1e-6) _camOff.copy(fwd).multiplyScalar(-dist);
    _camOff.normalize();

    _camGap.copy(cam.position).sub(this.mesh.position);

    // Hemisphere guard — the camera must never be in front of the nose.
    if (_camGap.dot(fwd) > 0) {
      cam.position.copy(desired);
      _camGap.copy(desired).sub(this.mesh.position);
    }

    // Minimum standoff, so the rig cannot end up inside the ~12-unit airframe
    // (or inside the near plane) during hard maneuvering.
    const MIN_DIST = 10.0;
    if (_camGap.lengthSq() < MIN_DIST * MIN_DIST) {
      cam.position.copy(this.mesh.position).addScaledVector(_camOff, MIN_DIST);
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
