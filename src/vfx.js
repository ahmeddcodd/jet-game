// vfx.js — drives the Blender-authored VFX geometry (see blender/build_vfx.py).
//
// Blender owns the FORMS, this owns the MOTION. Baking the animation into the
// assets — a simulated fireball flipbook, keyframed debris — would cost
// megabytes and still play back identically on every kill. Driving simple forms
// in code costs nothing and gives every explosion its own debris directions,
// spin, and timing.
//
// Everything here is POOLED. A single kill can put an explosion, a shockwave,
// eight debris chunks and five smoke blobs into the scene in one frame; doing
// that with fresh geometry and materials would allocate during the busiest
// moment of the game and leak GPU memory as the wreckage expired.
import * as THREE from 'three';
import { get } from './assets.js';
import { rand, randInt, clamp01 } from './utils.js';

const _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/* ---------- Colour ramps -------------------------------------------------
   Fire cools as it expands: white-hot core, orange body, then soot. Ramping
   the emissive along that curve is most of what separates an explosion from an
   orange ball that fades out. */
const FIRE_HOT = new THREE.Color(0xfff4cc);
const FIRE_MID = new THREE.Color(0xff8a22);
const FIRE_LOW = new THREE.Color(0x8c2f08);
const SMOKE_COL = new THREE.Color(0x2b2724);

class Pool {
  constructor(make) { this.make = make; this.free = []; this.live = []; }
  take() {
    const o = this.free.pop() || this.make();
    this.live.push(o);
    return o;
  }
  release(o) {
    const i = this.live.indexOf(o);
    if (i >= 0) this.live.splice(i, 1);
    o.root.visible = false;
    this.free.push(o);
  }
}

export class VFX {
  constructor(scene) {
    this.scene = scene;
    this.explosions = [];
    this.debris = [];
    this.flashes = [];

    // Source templates, cloned per instance. Geometry is shared by clone(),
    // so the whole system costs one copy of each buffer no matter how much
    // wreckage is in the air.
    this._expSrc = get('vfxExplosion');
    this._debSrc = get('vfxDebris');
    this._mzlSrc = get('vfxMuzzle');

    this._expPool = new Pool(() => this._makeExplosion());
    this._debPool = new Pool(() => this._makeDebris());
    this._mzlPool = new Pool(() => this._makeFlash());
  }

  // ---- Construction ------------------------------------------------------
  _makeExplosion() {
    const root = this._expSrc.clone(true);
    const parts = { shells: [], smoke: [], wave: null };
    root.traverse((o) => {
      if (!o.isMesh) return;
      // Per-instance materials so each explosion can run its own colour ramp
      // and opacity without every other one on screen following along.
      o.material = o.material.clone();
      o.material.transparent = true;
      o.material.depthWrite = false;
      o.material.toneMapped = false;
      if (/^Fire/.test(o.name)) {
        o.material.blending = THREE.AdditiveBlending;
        parts.shells.push(o);
      } else if (/^Shockwave/.test(o.name)) {
        o.material.blending = THREE.AdditiveBlending;
        parts.wave = o;
      } else if (/^Smoke/.test(o.name)) {
        o.material.toneMapped = true;      // smoke is lit, not emissive
        parts.smoke.push(o);
      }
      o.renderOrder = 6;
      o.castShadow = o.receiveShadow = false;
    });
    this.scene.add(root);
    return { root, parts, t: 0, life: 1, scale: 1, seed: 0 };
  }

  _makeDebris() {
    const root = new THREE.Group();
    // One random chunk per instance, picked at spawn so a kill throws a mix.
    const chunks = [];
    this._debSrc.traverse((o) => { if (o.isMesh && /^Chunk\d+$/.test(o.name)) chunks.push(o); });
    const pick = chunks[randInt(0, chunks.length - 1)].clone(true);
    pick.position.set(0, 0, 0);
    pick.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.castShadow = false; o.receiveShadow = false;
    });
    root.add(pick);
    this.scene.add(root);
    return {
      root, mesh: pick, t: 0, life: 1,
      vel: new THREE.Vector3(), spin: new THREE.Vector3(), smokeTimer: 0,
    };
  }

  _makeFlash() {
    const root = this._mzlSrc.clone(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.transparent = true;
      o.material.depthWrite = false;
      o.material.blending = THREE.AdditiveBlending;
      o.material.toneMapped = false;
      o.renderOrder = 7;
      o.castShadow = o.receiveShadow = false;
    });
    this.scene.add(root);
    return { root, t: 0, life: 0.06 };
  }

  // ---- Spawning ----------------------------------------------------------
  /**
   * @param {number} scale  world radius of the fireball at full expansion
   * @param {number} chunks how many debris pieces to throw (0 for a hit spark)
   */
  explode(pos, scale = 1, chunks = 0, velocity = null) {
    const e = this._expPool.take();
    e.root.position.copy(pos);
    e.root.rotation.set(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28));
    e.root.visible = true;
    e.t = 0;
    e.life = 0.55 + scale * 0.35;
    e.scale = scale;
    e.seed = rand(0, 100);
    for (const m of e.parts.smoke) {
      // Smoke drifts outward from wherever it started, so the cloud opens up
      // instead of scaling rigidly.
      m.userData.drift = new THREE.Vector3(rand(-1, 1), rand(-0.3, 1.1), rand(-1, 1))
        .normalize().multiplyScalar(rand(0.5, 1.4));
    }
    this.explosions.push(e);

    for (let i = 0; i < chunks; i++) this._throwDebris(pos, scale, velocity);
    return e;
  }

  _throwDebris(pos, scale, inherit) {
    const d = this._debPool.take();
    d.root.position.copy(pos);
    d.root.visible = true;
    d.t = 0;
    d.life = rand(2.2, 4.2);
    const s = scale * rand(0.5, 1.15);
    d.root.scale.setScalar(s);
    // Thrown outward from the blast, plus whatever the aircraft was doing —
    // wreckage keeps the victim's momentum, which is what makes it read as
    // coming *off* something rather than being emitted by a point.
    d.vel.set(rand(-1, 1), rand(-0.35, 1), rand(-1, 1)).normalize()
      .multiplyScalar(rand(12, 34) * scale);
    if (inherit) d.vel.addScaledVector(inherit, 0.55);
    d.spin.set(rand(-9, 9), rand(-9, 9), rand(-9, 9));
    d.smokeTimer = 0;
    this.debris.push(d);
  }

  /** Brief flash at a gun muzzle, oriented down the barrel. */
  muzzleFlash(pos, dir, scale = 1) {
    const f = this._mzlPool.take();
    f.root.position.copy(pos);
    f.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    // Random roll so repeated fire never strobes the identical shape.
    f.root.rotateZ(rand(0, 6.28));
    f.root.scale.setScalar(scale * rand(0.85, 1.25));
    f.root.visible = true;
    f.t = 0;
    this.flashes.push(f);
    return f;
  }

  // ---- Update ------------------------------------------------------------
  update(dt, particles) {
    this._updateExplosions(dt);
    this._updateDebris(dt, particles);
    this._updateFlashes(dt);
  }

  _updateExplosions(dt) {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.t += dt;
      const k = e.t / e.life;
      if (k >= 1) { this._expPool.release(e); this.explosions.splice(i, 1); continue; }

      // Shells expand fast then ease — real blasts decelerate hard as they
      // entrain air, so a linear expansion looks like an inflating balloon.
      const grow = 1 - Math.pow(1 - k, 2.6);
      e.parts.shells.forEach((m, idx) => {
        const lag = idx * 0.10;                    // outer shells trail the core
        const g = clamp01((grow - lag) / (1 - lag));
        m.scale.setScalar(Math.max(0.001, e.scale * (0.35 + g * 1.5) * (1 + idx * 0.22)));
        const heat = clamp01(1 - k * (1.35 + idx * 0.28));
        m.material.color.copy(FIRE_LOW).lerp(FIRE_MID, clamp01(heat * 1.7))
          .lerp(FIRE_HOT, clamp01(heat * heat * 1.4));
        m.material.opacity = heat * (0.95 - idx * 0.16);
        m.visible = m.material.opacity > 0.01;
      });

      if (e.parts.wave) {
        // The shockwave outruns the fireball and dies quickly.
        const wk = clamp01(k * 2.4);
        const w = e.parts.wave;
        w.scale.set(e.scale * (0.6 + wk * 4.2), e.scale * (0.6 + wk * 4.2), e.scale);
        w.material.opacity = (1 - wk) * 0.7;
        w.visible = w.material.opacity > 0.01;
      }

      e.parts.smoke.forEach((m, idx) => {
        // Smoke lags the fire, then outlives it and rises.
        const sk = clamp01((k - 0.16) / 0.84);
        const d = m.userData.drift;
        if (d) m.position.addScaledVector(d, e.scale * dt * 5.5);
        m.position.y += dt * 3.2 * e.scale * sk;
        m.scale.setScalar(Math.max(0.001, e.scale * (0.4 + sk * 1.9)));
        m.material.color.copy(FIRE_MID).lerp(SMOKE_COL, clamp01(sk * 2.2));
        m.material.opacity = Math.sin(clamp01(sk) * Math.PI) * 0.72;
        m.visible = m.material.opacity > 0.01;
      });
    }
  }

  _updateDebris(dt, particles) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.t += dt;
      if (d.t >= d.life || d.root.position.y < 1) {
        this._debPool.release(d); this.debris.splice(i, 1); continue;
      }
      d.vel.y -= 34 * dt;                       // same gravity as the flight model
      d.vel.multiplyScalar(1 - 0.35 * dt);      // air drag
      d.root.position.addScaledVector(d.vel, dt);
      d.root.rotation.x += d.spin.x * dt;
      d.root.rotation.y += d.spin.y * dt;
      d.root.rotation.z += d.spin.z * dt;

      // Trailing smoke, thinning as the piece cools.
      d.smokeTimer -= dt;
      if (particles && d.smokeTimer <= 0 && d.t < d.life * 0.7) {
        particles.smokePuff(d.root.position.clone(), 0x3a3430);
        d.smokeTimer = 0.04 + d.t * 0.05;
      }
    }
  }

  _updateFlashes(dt) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const k = f.t / f.life;
      if (k >= 1) { this._mzlPool.release(f); this.flashes.splice(i, 1); continue; }
      // Snap on, fall off fast — a muzzle flash is over in a couple of frames,
      // and anything slower reads as a flare rather than a gunshot.
      const a = 1 - k * k;
      f.root.traverse((o) => { if (o.isMesh) o.material.opacity = a; });
      f.root.scale.multiplyScalar(1 + dt * 5);
    }
  }

  /** Live counts, for profiling. */
  get counts() {
    return { explosions: this.explosions.length, debris: this.debris.length,
             flashes: this.flashes.length };
  }
}
