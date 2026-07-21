// flight.js — ONE flight model, flown by the player and the AI alike.
//
// Previously the two sides moved by completely different rules: the player had
// an energy model with lift-limited G and a coordinated turn, while enemies
// slerped their quaternion toward a target direction at a fixed rate and had
// their speed assigned directly. That made bandits able to turn just as hard at
// 40 units/s as at 200, and a diving bandit never gained a knot — so nothing
// the player learned about their own aircraft predicted what the enemy would
// do. Everything below is shared, so both aircraft obey the same envelope.
import * as THREE from 'three';
import { clamp, clamp01, damp } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);

// Module-local scratch. Every helper here documents which vectors it uses so
// callers can never be surprised by aliasing (a repeated source of bugs in
// this codebase — see the camera and bank-hold history).
const _f1 = new THREE.Vector3();
const _f2 = new THREE.Vector3();
const _f3 = new THREE.Vector3();
const _fq = new THREE.Quaternion();
const _fe = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * The shared performance envelope.
 *
 * Turn rate = G·g/V, and lift-limited G rises with V², so the sustained turn
 * rate peaks exactly at `cornerSpeed`. That single relationship is what makes
 * energy management matter for both sides of a fight.
 */
export const ENVELOPE = {
  gravity: 34,          // units/s² along the flight path
  cornerSpeed: 115,     // speed of peak turn rate
  gLimit: 9,            // structural ceiling
  thrustMil: 62,        // military power
  thrustAB: 132,        // afterburner
  dragPara: 0.002025,   // parasitic ∝ v²
  dragInduced: 0.90,    // induced ∝ G²
  rollRate: 3.4,        // rad/s
  stallSpeed: 42,
  minSpeed: 26,
  maxBank: 1.30,        // ~75°
  lowSpeedFloor: 0.22,  // floor under low-speed G so slow flight stays flyable
  turnGain: 1.45,       // arcade multiplier on the coordinated turn rate
};

/** Lift-limited G available at this speed. */
export function availableG(speed, env = ENVELOPE) {
  const vRatio = speed / env.cornerSpeed;
  const lift = env.gLimit *
    Math.max(env.lowSpeedFloor, Math.min(1, vRatio * vRatio));
  return Math.min(env.gLimit, lift);
}

/** Control effectiveness, which collapses below stall speed. */
export function controlAuthority(speed, env = ENVELOPE) {
  if (speed >= env.stallSpeed) return 1;
  return Math.max(0.5, clamp01((speed - env.minSpeed) / 16));
}

/**
 * Current bank angle, signed the same way as a positive roll about local +Z
 * (which lifts local +X, the left wing) — so positive means banked to the
 * aircraft's right. Signing this the other way turns any bank-hold built on it
 * into positive feedback.
 */
export function bankAngleOf(quat) {
  const leftWingY = _f1.set(1, 0, 0).applyQuaternion(quat).y;
  const upY = _f2.set(0, 1, 0).applyQuaternion(quat).y;
  return Math.atan2(leftWingY, upY);
}

/** World-Y component of the aircraft's own up vector. */
export function uprightness(quat) {
  return _f1.set(0, 1, 0).applyQuaternion(quat).y;
}

/**
 * Bank angle needed to turn toward `desiredDir` (a unit vector).
 * Returns radians, positive = bank right, clamped to the envelope.
 *
 * This is how a pilot turns — pick a bank, then let the turn develop — rather
 * than rotating the nose straight onto the target vector. It is what stops AI
 * movement looking like a mouse cursor snapping to a point.
 */
export function bankForTurn(quat, desiredDir, env = ENVELOPE, gain = 2.6) {
  const fwd = _f1.set(0, 0, 1).applyQuaternion(quat);
  // Signed horizontal error. cross(fwd, desired)·UP > 0 means the target lies
  // toward world +X, which is the aircraft's left, so negate for bank sign.
  const err = _f2.crossVectors(fwd, desiredDir).dot(UP);
  return clamp(-err * gain, -env.maxBank, env.maxBank);
}

/**
 * Pitch command in [-1, 1] (+1 = pull) to close the vertical error toward
 * `desiredDir`. Separating this from bank keeps climb and turn independent,
 * which is what makes the resulting motion legible.
 */
export function pitchForClimb(quat, desiredDir, gain = 2.4) {
  const fwdY = _f1.set(0, 0, 1).applyQuaternion(quat).y;
  return clamp((desiredDir.y - fwdY) * gain, -1, 1);
}

/** Fresh control state for an aircraft flying this model. */
export function createFlightState(speed) {
  return { speed, pitch: 0, yaw: 0, roll: 0, gLoad: 1 };
}

/**
 * Advance one aircraft by `dt` under the shared model.
 *
 * `fs`  — flight state from createFlightState (mutated).
 * `cmd` — { bank, pitch, yaw, throttle, boost, freeRoll }
 *           bank      target bank angle in radians (ignored if freeRoll set)
 *           pitch     -1..1, +1 = pull
 *           yaw       -1..1 rudder
 *           throttle  0..1
 *           boost     afterburner
 *           freeRoll  raw roll rate in rad/s, bypassing the bank hold
 *                     (aerobatics, scripted maneuvers)
 *           noCoordTurn  skip the coordinated turn (e.g. mid-maneuver)
 *
 * Returns nothing; mutates `mesh.quaternion` and `fs`.
 */
export function integrate(mesh, fs, cmd, dt, env = ENVELOPE) {
  const authority = controlAuthority(fs.speed, env);
  const availG = availableG(fs.speed, env) * authority;

  // ---- Pitch: G-limited, so turn rate falls away from corner speed --------
  const pitchCmd = clamp(cmd.pitch || 0, -1, 1);
  const cmdG = Math.abs(pitchCmd) * availG;
  fs.gLoad = damp(fs.gLoad, 1 + cmdG, 7, dt);
  const pitchRate = -Math.sign(pitchCmd) *
    (cmdG * env.gravity * 1.30) / Math.max(fs.speed, 24);

  // ---- Roll: hold a commanded bank, or free-roll ---------------------------
  // freeRoll is rate control; absent (null/undefined) means hold a bank angle.
  // Testing truthiness here is wrong: a scripted maneuver legitimately commands
  // rate ZERO to hold whatever bank it has reached — the Split-S is inverted at
  // that point — and treating 0 as "no command" made the jet roll upright in
  // the middle of the maneuver.
  let rollRate;
  if (cmd.freeRoll !== undefined && cmd.freeRoll !== null) {
    rollRate = cmd.freeRoll * env.rollRate * authority;
  } else {
    const bankNow = bankAngleOf(mesh.quaternion);
    const bankWant = clamp(cmd.bank || 0, -env.maxBank, env.maxBank);
    rollRate = clamp((bankWant - bankNow) * 3.2, -env.rollRate, env.rollRate) * authority;
  }

  const yawRate = clamp(cmd.yaw || 0, -1, 1) * 0.42 * authority;

  const resp = 8.5;
  fs.pitch = damp(fs.pitch, pitchRate, resp, dt);
  fs.yaw   = damp(fs.yaw, yawRate, resp, dt);
  fs.roll  = damp(fs.roll, rollRate, resp * 1.3, dt);

  _fe.set(fs.pitch * dt, fs.yaw * dt, fs.roll * dt, 'YXZ');
  _fq.setFromEuler(_fe);
  mesh.quaternion.multiply(_fq).normalize();

  // ---- Coordinated turn ---------------------------------------------------
  // Applied about the WORLD vertical so a banked turn is exactly horizontal.
  // Adding it as body pitch instead splits into sin(φ) horizontal and cos(φ)
  // vertical, and since gravity here only bleeds speed along the flight path
  // (it never curves the trajectory) nothing absorbs that vertical part — the
  // aircraft climbs out of every turn. Rate is the real level-turn relation
  // ω = g·tan(φ)/V, so steeper banks turn harder and faster jets turn wider.
  if (!cmd.noCoordTurn && uprightness(mesh.quaternion) > 0.2) {
    const phi = clamp(bankAngleOf(mesh.quaternion), -1.30, 1.30);
    const turn = (env.gravity * Math.tan(phi)) / Math.max(fs.speed, 45);
    if (Math.abs(turn) > 1e-5) {
      // Positive rotation about world +Y carries the nose toward world +X,
      // which is the aircraft's left, so a right bank needs a negative one.
      _fq.setFromAxisAngle(UP, -turn * env.turnGain * dt);
      mesh.quaternion.premultiply(_fq).normalize();
    }
  }

  // ---- Energy -------------------------------------------------------------
  const fwdY = _f3.set(0, 0, 1).applyQuaternion(mesh.quaternion).y;
  const thrust = cmd.boost
    ? env.thrustAB
    : (env.thrustMil * 0.15) + (env.thrustMil * 0.85) * clamp01(cmd.throttle ?? 1);
  const gravityAccel = -env.gravity * fwdY;          // climb costs, dive pays
  const drag = env.dragPara * fs.speed * fs.speed
             + env.dragInduced * fs.gLoad * fs.gLoad;
  fs.speed = Math.max(env.minSpeed,
    fs.speed + (thrust + gravityAccel - drag) * dt);

  // ---- Departure ----------------------------------------------------------
  if (fs.speed < env.stallSpeed) {
    _f1.set(1, 0, 0).applyQuaternion(mesh.quaternion);
    const drop = (1 - fs.speed / env.stallSpeed) * 0.9 * dt;
    _fq.setFromAxisAngle(_f1, -drop * Math.sign(fwdY || 1));
    mesh.quaternion.premultiply(_fq).normalize();
  }
}

/**
 * Throttle setting that will hold `target` speed, given the current state.
 * Lets the AI ask for a speed while still obeying thrust and drag, instead of
 * assigning its speed directly.
 */
export function throttleForSpeed(fs, target, fwdY, env = ENVELOPE) {
  const drag = env.dragPara * fs.speed * fs.speed
             + env.dragInduced * fs.gLoad * fs.gLoad;
  const gravityAccel = -env.gravity * fwdY;
  // Thrust needed to hold speed, plus a term that closes the error.
  const need = drag - gravityAccel + (target - fs.speed) * 0.9;
  const idle = env.thrustMil * 0.15;
  return clamp01((need - idle) / (env.thrustMil * 0.85));
}
