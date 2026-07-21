// targeting.js — radar/seeker target locking.
//
// A lock is not instant: the seeker has to hold a bandit inside its cone for
// an acquisition period before it goes solid, and it degrades gracefully when
// the target breaks out rather than snapping off. That delay is what gives the
// defender something to fight against — breaking hard before the tone goes
// solid is the counter to being locked.
import * as THREE from 'three';
import { clamp01 } from './utils.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export const LOCK_STATE = {
  SEARCHING: 'searching',
  ACQUIRING: 'acquiring',
  LOCKED: 'locked',
};

export const RADAR = {
  range: 1800,
  cone: 0.90,          // dot(boresight, toTarget) required to track
  acquireTime: 1.15,   // seconds inside the cone before the lock goes solid
  breakGrace: 0.55,    // seconds allowed outside the cone before it drops
  reacquireCone: 0.80, // slightly wider once locked — a lock is stickier than an acquisition
};

export class TargetingComputer {
  constructor() {
    this.target = null;
    this.state = LOCK_STATE.SEARCHING;
    this.progress = 0;       // 0..1 acquisition progress
    this.outside = 0;        // seconds the target has been out of the cone
    this.manual = false;     // true when the player picked this target explicitly
    this.onLock = null;      // hooks for audio/HUD callouts
    this.onLockLost = null;
  }

  get isLocked() { return this.state === LOCK_STATE.LOCKED; }
  get lockedTarget() { return this.state === LOCK_STATE.LOCKED ? this.target : null; }

  clear(silent = false) {
    const had = this.state === LOCK_STATE.LOCKED;
    this.target = null;
    this.state = LOCK_STATE.SEARCHING;
    this.progress = 0;
    this.outside = 0;
    this.manual = false;
    if (had && !silent && this.onLockLost) this.onLockLost();
  }

  /** Range only — used to keep a hand-picked target that is off the nose. */
  _inRadarRange(player, enemy) {
    if (!enemy || !enemy.alive) return false;
    return _v1.copy(enemy.position).sub(player.position).length() <= RADAR.range;
  }

  /** Angle test + range test for one candidate. Returns dot, or null if out of range. */
  _track(player, enemy, cone) {
    if (!enemy || !enemy.alive) return null;
    const to = _v1.copy(enemy.position).sub(player.position);
    const dist = to.length();
    if (dist > RADAR.range || dist < 1) return null;
    to.divideScalar(dist);
    const fwd = _v2.set(0, 0, 1).applyQuaternion(player.mesh.quaternion);
    const dot = fwd.dot(to);
    return dot >= cone ? { dot, dist } : null;
  }

  /** Best candidate = closest to boresight, not merely closest in space. */
  _bestCandidate(player, enemies) {
    let best = null, bestDot = RADAR.cone;
    for (const e of enemies) {
      const t = this._track(player, e, RADAR.cone);
      if (t && t.dot > bestDot) { bestDot = t.dot; best = e; }
    }
    return best;
  }

  /**
   * Every live bandit in radar range, nearest-the-nose first — regardless of
   * whether it is in the seeker cone.
   *
   * DESIGNATING a target and LOCKING it are different things. Both R and Tab
   * used to filter by the 25.8-degree seeker cone, which meant that the moment
   * a bandit slid off the nose — exactly when you want to call it out and go
   * after it — neither key did anything at all. You had to fly it back into the
   * cone by eye first, with no cue for which way to turn.
   *
   * Designation is now free in any direction; the lock still has to be earned
   * by pulling the nose onto it and holding it there.
   */
  _inRange(player, enemies) {
    const fwd = _v2.set(0, 0, 1).applyQuaternion(player.mesh.quaternion);
    const out = [];
    for (const e of enemies) {
      if (!e || !e.alive) continue;
      const to = _v1.copy(e.position).sub(player.position);
      const dist = to.length();
      if (dist > RADAR.range || dist < 1) continue;
      out.push({ e, dot: fwd.dot(to.divideScalar(dist)), dist });
    }
    // Nearest the nose first, so repeated Tab presses walk outward from the
    // boresight instead of jumping around in spawn order.
    out.sort((a, b) => b.dot - a.dot);
    return out;
  }

  /** Cycle to the next bandit in radar range (Tab). */
  cycle(player, enemies) {
    const valid = this._inRange(player, enemies).map((c) => c.e);
    if (!valid.length) { this.clear(); return null; }
    const i = valid.indexOf(this.target);
    const next = valid[(i + 1) % valid.length];
    this._select(next, true);
    return next;
  }

  /** Designate whatever is nearest the nose, anywhere in radar range (R). */
  lockNearest(player, enemies) {
    const best = this._bestCandidate(player, enemies)
      || (this._inRange(player, enemies)[0] || {}).e;
    if (best) this._select(best, true);
    return best;
  }

  _select(enemy, manual) {
    if (this.target !== enemy) {
      this.target = enemy;
      this.state = LOCK_STATE.ACQUIRING;
      this.progress = 0;
      this.outside = 0;
    }
    this.manual = manual;
  }

  update(dt, player, enemies) {
    // A dead or despawned target drops everything immediately.
    if (this.target && (!this.target.alive || !enemies.includes(this.target))) {
      this.clear();
    }

    // Auto-acquire only when the player hasn't picked something themselves.
    if (!this.target && !this.manual) {
      const best = this._bestCandidate(player, enemies);
      if (best) this._select(best, false);
    }
    if (!this.target) {
      this.state = LOCK_STATE.SEARCHING;
      this.progress = 0;
      return;
    }

    // Once solid, the seeker tolerates a wider cone — hard to shake, not impossible.
    const cone = this.state === LOCK_STATE.LOCKED ? RADAR.reacquireCone : RADAR.cone;
    const track = this._track(player, this.target, cone);

    if (track) {
      this.outside = 0;
      if (this.state !== LOCK_STATE.LOCKED) {
        this.progress = clamp01(this.progress + dt / RADAR.acquireTime);
        if (this.progress >= 1) {
          this.state = LOCK_STATE.LOCKED;
          if (this.onLock) this.onLock(this.target);
        }
      }
    } else {
      // Outside the cone: acquisition decays fast, an existing lock coasts on
      // the grace timer before breaking.
      this.outside += dt;
      if (this.state === LOCK_STATE.LOCKED) {
        if (this.outside > RADAR.breakGrace) this.clear();
      } else {
        this.progress = Math.max(0, this.progress - dt / (RADAR.acquireTime * 0.6));
        // A target the pilot picked by hand is kept until it dies or leaves
        // radar range. Dropping it for being off the nose defeats the point:
        // you designate precisely because you have lost sight of it, and the
        // HUD arrow then tells you which way to pull.
        if (!this.manual && this.outside > RADAR.breakGrace * 2) this.clear(true);
        if (this.manual && !this._inRadarRange(player, this.target)) this.clear(true);
      }
    }
  }
}
