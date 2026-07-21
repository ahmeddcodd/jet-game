// vfx.js — drives the Blender-authored VFX geometry (see blender/build_vfx.py).
//
// Blender owns the FORMS, this owns the MOTION and the SHADING. Baking the
// animation into the assets — a simulated fireball flipbook, keyframed debris —
// would cost megabytes and still play back identically on every kill. Driving
// simple forms in code costs nothing and gives every explosion its own churn,
// debris directions, spin and timing.
//
// WHY THIS IS A SHADER AND NOT A COLOURED MESH
// --------------------------------------------
// A textured or vertex-coloured sphere always reads as a sphere. Four things
// separate real fire from a glowing ball, and all four are per-pixel:
//
//   1. NO HARD EDGE. A solid mesh standing in for a volume must fade where the
//      surface turns away from the eye — a ray through the middle passes
//      through much more fire than one at the rim. Without this the silhouette
//      is a crisp circle and nothing else can save it.
//   2. CHURN. Fire boils. A domain-warped noise field drifting through the
//      shell makes the surface turbulent instead of uniformly scaling.
//   3. TEMPERATURE, NOT COLOUR. Hot spots and cool spots coexist in the same
//      frame. Ramping through a blackbody curve driven by the noise gives white
//      cores and dull red fringes simultaneously, which a single tinted mesh
//      cannot.
//   4. DISSOLVE, NOT FADE. Fire breaks into wisps as it dies. Eroding the alpha
//      against the noise with a rising threshold does that; lowering opacity
//      uniformly just makes a ghost ball.
//
// Everything here is POOLED. A single kill can put a fireball, a shockwave,
// eight debris chunks, six smoke billows and a hundred embers into the scene in
// one frame; doing that with fresh geometry and materials would allocate during
// the busiest moment of the game and leak GPU memory as the wreckage expired.
import * as THREE from 'three';
import { get } from './assets.js';
import { rand, randInt, clamp01 } from './utils.js';

const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();

/* ---------- Shared GLSL -------------------------------------------------- */

// Gradient noise + fbm. Cheap enough to run four octaves on every fire pixel,
// which is what the churn needs; a texture lookup would tile visibly on a shape
// that scales by 5x over its life.
const NOISE_GLSL = /* glsl */`
vec3 hash33(vec3 p){
  p = vec3(dot(p, vec3(127.1, 311.7,  74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}
float gnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dot(hash33(i + vec3(0,0,0)), f - vec3(0,0,0)),
                     dot(hash33(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                 mix(dot(hash33(i + vec3(0,1,0)), f - vec3(0,1,0)),
                     dot(hash33(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
             mix(mix(dot(hash33(i + vec3(0,0,1)), f - vec3(0,0,1)),
                     dot(hash33(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                 mix(dot(hash33(i + vec3(0,1,1)), f - vec3(0,1,1)),
                     dot(hash33(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z) * 2.0;
}
// Two sizes. The warp only shifts where the detail is sampled and is never
// seen directly, so it runs at two octaves; the detail pass runs at three.
// Eight gradient-noise evaluations per pixel (four plus four) was the single
// most expensive thing on screen once several blasts overlapped.
float fbmWarp(vec3 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 2; i++){ v += a * gnoise(p); p *= 2.02; a *= 0.5; }
  return v;
}
float fbm(vec3 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++){ v += a * gnoise(p); p *= 2.02; a *= 0.5; }
  return v;
}
`;

// Blackbody-ish ramp. Deep ember red through orange to a white-hot core — the
// same progression a real fire runs through, which is why fire looks "right"
// when the colour tracks intensity rather than being picked.
const FIRE_RAMP_GLSL = /* glsl */`
vec3 fireRamp(float t){
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.30, 0.026, 0.004), vec3(0.95, 0.20, 0.018), smoothstep(0.00, 0.34, t));
  c = mix(c, vec3(1.00, 0.58, 0.10), smoothstep(0.30, 0.60, t));
  c = mix(c, vec3(1.00, 0.90, 0.58), smoothstep(0.56, 0.84, t));
  c = mix(c, vec3(1.00, 0.99, 0.95), smoothstep(0.84, 1.00, t));
  return c;
}
`;

const VERT = /* glsl */`
varying vec3 vObj;
varying vec3 vNrm;
varying vec3 vWpos;
void main(){
  vObj  = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWpos = wp.xyz;
  vNrm  = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

function fireMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uAge: { value: 0 }, uSeed: { value: 0 },
      uGain: { value: 1 }, uFreq: { value: 2.6 },
    },
    vertexShader: VERT,
    fragmentShader: NOISE_GLSL + FIRE_RAMP_GLSL + /* glsl */`
      varying vec3 vObj; varying vec3 vNrm; varying vec3 vWpos;
      uniform float uTime, uAge, uSeed, uGain, uFreq;
      void main(){
        vec3 V = normalize(cameraPosition - vWpos);
        float facing = abs(dot(normalize(vNrm), V));
        // The mesh is a stand-in for a volume: a view ray through the middle
        // crosses far more fire than one at the rim, so the middle is dense and
        // the rim disappears. This is what kills the hard sphere silhouette.
        float thick = pow(clamp(facing, 0.0, 1.0), 1.45);

        // Churn. The field drifts upward through the shell and is warped by a
        // second, coarser sample of itself, so it boils instead of sliding.
        vec3 q = vObj * uFreq + vec3(0.0, -uTime * 1.25, 0.0) + uSeed;
        float w = fbmWarp(q * 0.85);
        float d = fbm(q + w * 1.5) * 0.5 + 0.5;

        // Temperature falls with age and with distance through the volume, so a
        // single shell shows a white core and dull red fringes at once.
        // 1.15, not higher: three shells stack additively, so a gain that looks
        // right on one blows the middle of the fireball out to flat white and
        // takes the churn with it. Real fire is a small white core in a large
        // orange body, not a white ball.
        float temp = d * thick * 1.15 * uGain * (1.0 - uAge * 0.82);
        vec3 col = fireRamp(temp);

        // Dissolve into wisps rather than fading uniformly.
        float thr = mix(-0.38, 1.06, uAge);
        float a = smoothstep(thr, thr + 0.40, d) * thick * uGain * 0.92;
        a *= smoothstep(1.0, 0.80, uAge);
        if (a < 0.004) discard;
        gl_FragColor = vec4(col * a, a);   // premultiplied for ONE/ONE add
      }
    `,
    transparent: true,
    depthWrite: false,
    // True additive. THREE's AdditiveBlending is SRC_ALPHA/ONE, which would
    // multiply by alpha a second time on top of the premultiply above and crush
    // the fringes to nothing.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function smokeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uAge: { value: 0 }, uSeed: { value: 0 },
      uGain: { value: 1 },
      uLightDir: { value: new THREE.Vector3(0.4, 0.85, 0.3).normalize() },
      uAmbient: { value: new THREE.Color(0x5b6a7a) },
    },
    vertexShader: VERT,
    fragmentShader: NOISE_GLSL + /* glsl */`
      varying vec3 vObj; varying vec3 vNrm; varying vec3 vWpos;
      uniform float uTime, uAge, uSeed, uGain;
      uniform vec3 uLightDir, uAmbient;
      void main(){
        vec3 N = normalize(vNrm);
        vec3 V = normalize(cameraPosition - vWpos);
        float thick = pow(clamp(abs(dot(N, V)), 0.0, 1.0), 1.15);

        vec3 q = vObj * 2.1 + vec3(0.0, -uTime * 0.42, 0.0) + uSeed;
        float w = fbmWarp(q * 0.8);
        float d = fbm(q + w * 1.15) * 0.5 + 0.5;

        // Cheap volumetric shading. Smoke without a light gradient reads as a
        // flat grey blob; lighting one side and darkening the dense interior is
        // enough to give it form.
        float lam = clamp(dot(N, uLightDir) * 0.5 + 0.5, 0.0, 1.0);
        float shade = mix(0.34, 1.0, lam) * mix(1.0, 0.52, d);

        // Freshly made smoke still has fire in it and cools to soot.
        vec3 hot  = vec3(1.00, 0.36, 0.07);
        vec3 soot = vec3(0.085, 0.078, 0.072);
        vec3 col = mix(hot, soot, smoothstep(0.0, 0.30, uAge)) * shade;
        col += uAmbient * 0.16 * smoothstep(0.15, 0.8, uAge);

        float thr = mix(-0.34, 1.06, uAge);
        float a = smoothstep(thr, thr + 0.46, d) * thick * uGain;
        a *= smoothstep(0.0, 0.10, uAge);     // billow in
        a *= smoothstep(1.0, 0.66, uAge);     // thin out
        if (a < 0.004) discard;
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function waveMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uAge: { value: 0 }, uGain: { value: 1 } },
    vertexShader: VERT,
    fragmentShader: /* glsl */`
      varying vec3 vObj; varying vec3 vNrm; varying vec3 vWpos;
      uniform float uAge, uGain;
      void main(){
        vec3 V = normalize(cameraPosition - vWpos);
        float rim = 1.0 - abs(dot(normalize(vNrm), V));
        // Bright on the grazing edge only, so the ring reads as a thin sheet of
        // compressed air rather than a solid torus.
        float a = pow(clamp(rim, 0.0, 1.0), 2.2) * (1.0 - uAge) * uGain;
        if (a < 0.004) discard;
        vec3 col = mix(vec3(1.0, 0.72, 0.36), vec3(1.0, 0.98, 0.92), rim);
        gl_FragColor = vec4(col * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

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

// Lights are allocated once and never added or removed. Changing the number of
// lights in the scene forces THREE to recompile every material that reacts to
// them, which would stutter on exactly the frame an explosion goes off.
const FLASH_LIGHTS = 3;

// Each explosion is three fire shells plus six smoke billows, all transparent
// and all overlapping. Ten is where the overdraw stays affordable.
const MAX_EXPLOSIONS = 10;

export class VFX {
  constructor(scene) {
    this.scene = scene;
    this.explosions = [];
    this.debris = [];
    this.flashes = [];
    this.embers = [];
    this.pending = [];        // delayed secondary blasts
    this.time = 0;

    // Source templates, cloned per instance. Geometry is shared by clone(), so
    // the whole system costs one copy of each buffer no matter how much
    // wreckage is in the air.
    this._expSrc = get('vfxExplosion');
    this._debSrc = get('vfxDebris');
    this._mzlSrc = get('vfxMuzzle');

    this._expPool = new Pool(() => this._makeExplosion());
    this._debPool = new Pool(() => this._makeDebris());
    this._mzlPool = new Pool(() => this._makeFlash());

    this._initLights();
    this._initEmbers();
  }

  _initLights() {
    this._lights = [];
    for (let i = 0; i < FLASH_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffb066, 0, 900, 2);
      l.castShadow = false;
      l.visible = false;
      this.scene.add(l);
      this._lights.push({ light: l, t: 0, life: 0, peak: 0 });
    }
  }

  /**
   * Embers are one InstancedMesh, not one object each. A blast throws a hundred
   * of them and each covers a dozen pixels — as separate meshes that would be a
   * hundred draw calls for almost no coverage.
   */
  _initEmbers() {
    const src = get('vfxEmber');
    let geo = null;
    src.traverse((o) => { if (!geo && o.isMesh) geo = o.geometry; });
    this.EMBER_MAX = 320;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this._emberMesh = new THREE.InstancedMesh(geo, mat, this.EMBER_MAX);
    this._emberMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._emberMesh.frustumCulled = false;   // instances move far from the origin
    this._emberMesh.count = 0;
    this._emberMesh.renderOrder = 7;
    // setColorAt allocates the instanceColor buffer; embers fade individually.
    this._emberMesh.setColorAt(0, _col.setRGB(1, 1, 1));
    this.scene.add(this._emberMesh);
  }

  // ---- Construction ------------------------------------------------------
  _makeExplosion() {
    const root = this._expSrc.clone(true);
    const parts = { shells: [], smoke: [], wave: null };
    root.traverse((o) => {
      if (!o.isMesh) return;
      // Per-instance materials so each explosion runs its own churn seed, age
      // and gain without every other one on screen following along. Clones
      // share the compiled program, so this costs uniforms, not shaders.
      if (/^Fire/.test(o.name)) {
        o.material = fireMaterial();
        parts.shells.push(o);
      } else if (/^Shockwave/.test(o.name)) {
        o.material = waveMaterial();
        parts.wave = o;
      } else if (/^Smoke/.test(o.name)) {
        o.material = smokeMaterial();
        parts.smoke.push(o);
      } else {
        o.visible = false;
        return;
      }
      o.renderOrder = /^Smoke/.test(o.name) ? 5 : 6;
      o.castShadow = o.receiveShadow = false;
      o.frustumCulled = false;   // shells scale far past their authored bounds
    });
    this.scene.add(root);
    return { root, parts, t: 0, life: 1, fireLife: 1, scale: 1, seed: 0 };
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
    const parts = { burst: [], puff: null };
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (/Puff/.test(o.name)) {
        o.material = smokeMaterial();
        parts.puff = o;
      } else {
        o.material = fireMaterial();
        o.material.uniforms.uFreq.value = 5.5;   // finer detail at muzzle scale
        parts.burst.push(o);
      }
      o.renderOrder = 7;
      o.castShadow = o.receiveShadow = false;
      o.frustumCulled = false;
    });
    this.scene.add(root);
    return { root, parts, t: 0, life: 0.075 };
  }

  // ---- Lights ------------------------------------------------------------
  /** Flash the world. An explosion that doesn't light what's around it is the
   *  clearest tell that it's a sprite pasted over the scene. */
  _flashLight(pos, scale, colour = 0xffa64d) {
    // Steal the dimmest slot rather than skipping — a big blast going dark
    // because three small ones are running is worse than cutting one short.
    let slot = this._lights[0];
    for (const l of this._lights) {
      if (!l.light.visible) { slot = l; break; }
      if (l.peak * (1 - l.t / l.life) < slot.peak * (1 - slot.t / slot.life)) slot = l;
    }
    slot.light.position.copy(pos);
    slot.light.color.set(colour);
    slot.light.distance = 90 + scale * 130;
    slot.peak = 22 + scale * 42;
    slot.life = 0.30 + scale * 0.22;
    slot.t = 0;
    slot.light.intensity = slot.peak;
    slot.light.visible = true;
  }

  // ---- Spawning ----------------------------------------------------------
  /**
   * @param {number} scale  world radius of the fireball at full expansion
   * @param {number} chunks how many debris pieces to throw (0 for a hit spark)
   */
  explode(pos, scale = 1, chunks = 0, velocity = null) {
    // Retire the oldest rather than refusing the new one: the blast the player
    // just caused must always be the one they see. Smoke lingering for seconds
    // is what stacks these up, so without a cap a twelve-kill wave leaves two
    // dozen nine-mesh explosions overlapping.
    while (this.explosions.length >= MAX_EXPLOSIONS) {
      const old = this.explosions.shift();
      this._expPool.release(old);
    }
    const e = this._expPool.take();
    e.root.position.copy(pos);
    e.root.rotation.set(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28));
    e.root.visible = true;
    e.t = 0;
    e.scale = scale;
    e.seed = rand(0, 100);
    // Fire is brief; the smoke it leaves outlives it by several seconds. Tying
    // both to one lifetime is why game explosions so often vanish all at once.
    e.fireLife = 0.42 + scale * 0.30;
    e.life = e.fireLife + 2.2 + scale * 1.1;

    for (const m of e.parts.shells) {
      m.material.uniforms.uSeed.value = e.seed + rand(0, 9);
      m.material.uniforms.uGain.value = 1;
    }
    for (const m of e.parts.smoke) {
      m.material.uniforms.uSeed.value = e.seed + rand(0, 30);
      // Smoke drifts outward from wherever it started, so the cloud opens up
      // instead of scaling rigidly.
      m.userData.drift = new THREE.Vector3(rand(-1, 1), rand(-0.25, 1.1), rand(-1, 1))
        .normalize().multiplyScalar(rand(0.55, 1.5));
      m.userData.spin = rand(-0.5, 0.5);
    }
    this.explosions.push(e);

    this._flashLight(pos, scale);
    for (let i = 0; i < chunks; i++) this._throwDebris(pos, scale, velocity);
    // Embers scale with the blast; a bullet spark gets a handful, a kill gets a
    // shower.
    this._emitEmbers(pos, scale, Math.round(14 + scale * 26), velocity);

    // Secondary detonations for anything aircraft-sized — fuel and ordnance
    // don't all go up in the same instant, and the stagger is a large part of
    // why real explosions read as violent rather than as a single pop.
    if (scale >= 2.6) {
      for (let i = 0; i < 1; i++) {
        this.pending.push({
          at: this.time + rand(0.10, 0.34),
          pos: pos.clone().add(new THREE.Vector3(
            rand(-1, 1), rand(-0.6, 0.8), rand(-1, 1)).multiplyScalar(scale * 1.5)),
          scale: scale * rand(0.35, 0.55),
          vel: velocity ? velocity.clone() : null,
        });
      }
    }
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

  _emitEmbers(pos, scale, count, inherit) {
    for (let i = 0; i < count; i++) {
      if (this.embers.length >= this.EMBER_MAX) break;
      const vel = new THREE.Vector3(rand(-1, 1), rand(-0.3, 1), rand(-1, 1))
        .normalize().multiplyScalar(rand(9, 40) * (0.5 + scale * 0.5));
      if (inherit) vel.addScaledVector(inherit, 0.35);
      this.embers.push({
        pos: pos.clone().add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1))
          .multiplyScalar(scale * 0.5)),
        vel,
        t: 0,
        life: rand(0.7, 2.4),
        size: rand(0.10, 0.34) * (0.6 + scale * 0.5),
        // Each ember flickers on its own phase, so the shower shimmers instead
        // of pulsing in unison.
        phase: rand(0, 6.28),
        rate: rand(14, 34),
        spin: rand(-14, 14),
      });
    }
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
    for (const m of f.parts.burst) m.material.uniforms.uSeed.value = rand(0, 100);
    if (f.parts.puff) f.parts.puff.material.uniforms.uSeed.value = rand(0, 100);
    this.flashes.push(f);
    // A few sparks straight down the barrel, and a small light so the muzzle
    // lights the nose of the aircraft firing.
    this._emitEmbers(pos.clone().addScaledVector(dir, scale * 0.6), scale * 0.35, 3, null);
    this._flashLight(pos, scale * 0.28, 0xffd9a0);
    return f;
  }

  // ---- Update ------------------------------------------------------------
  update(dt, particles) {
    this.time += dt;
    this._updatePending();
    this._updateExplosions(dt);
    this._updateDebris(dt, particles);
    this._updateFlashes(dt);
    this._updateEmbers(dt);
    this._updateLights(dt);
  }

  _updatePending() {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (this.time < p.at) continue;
      this.pending.splice(i, 1);
      this.explode(p.pos, p.scale, 0, p.vel);
    }
  }

  _updateExplosions(dt) {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.t += dt;
      if (e.t >= e.life) { this._expPool.release(e); this.explosions.splice(i, 1); continue; }

      const kf = clamp01(e.t / e.fireLife);        // fire's own clock
      const ks = clamp01(e.t / e.life);            // smoke's clock

      // Shells expand fast then ease — real blasts decelerate hard as they
      // entrain air, so a linear expansion looks like an inflating balloon.
      const grow = 1 - Math.pow(1 - kf, 2.6);
      e.parts.shells.forEach((m, idx) => {
        const lag = idx * 0.10;                    // outer shells trail the core
        const g = clamp01((grow - lag) / (1 - lag));
        m.scale.setScalar(Math.max(0.001, e.scale * (0.30 + g * 1.35) * (1 + idx * 0.20)));
        const u = m.material.uniforms;
        u.uTime.value = this.time;
        u.uAge.value = clamp01(kf * (1.0 + idx * 0.16));
        u.uGain.value = 1 - idx * 0.24;
        m.visible = u.uAge.value < 1;
      });

      if (e.parts.wave) {
        // The shockwave outruns the fireball and dies quickly.
        const wk = clamp01(e.t / (e.fireLife * 0.55));
        const w = e.parts.wave;
        const r = e.scale * (0.6 + wk * 4.6);
        w.scale.set(r, r, e.scale * 0.9);
        w.material.uniforms.uAge.value = wk;
        w.visible = wk < 1;
      }

      e.parts.smoke.forEach((m, idx) => {
        // Smoke lags the fire, then outlives it and rises. Its own clock runs
        // to the full lifetime, so the fire can be long gone while the column
        // is still climbing.
        const sk = clamp01((ks - 0.05) / 0.95);
        const d = m.userData.drift;
        if (d) m.position.addScaledVector(d, e.scale * dt * 2.4 * (1 - sk * 0.7));
        m.position.y += dt * (2.6 + sk * 5.0) * e.scale * 0.5;
        m.rotation.y += (m.userData.spin || 0) * dt;
        // Keeps growing the whole way — smoke never stops entraining air.
        m.scale.setScalar(Math.max(0.001, e.scale * (0.35 + sk * 2.6)));
        const u = m.material.uniforms;
        u.uTime.value = this.time;
        u.uAge.value = sk;
        u.uGain.value = 1;
        m.visible = sk < 1;
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
      // Hot wreckage sheds sparks for the first moment of its arc.
      if (d.t < 0.5 && Math.random() < dt * 12) {
        this._emitEmbers(d.root.position, 0.5, 1, d.vel);
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
      for (const m of f.parts.burst) {
        const u = m.material.uniforms;
        u.uTime.value = this.time;
        u.uAge.value = k;
        u.uGain.value = 1 - k * k;
      }
      if (f.parts.puff) {
        const u = f.parts.puff.material.uniforms;
        u.uTime.value = this.time;
        u.uAge.value = k;
        u.uGain.value = 0.5;
      }
      f.root.scale.multiplyScalar(1 + dt * 5);
    }
  }

  _updateEmbers(dt) {
    const mesh = this._emberMesh;
    let n = 0;
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.t += dt;
      if (e.t >= e.life || e.pos.y < 0.5) { this.embers.splice(i, 1); continue; }
      e.vel.y -= 26 * dt;
      e.vel.multiplyScalar(1 - 1.7 * dt);        // sparks are light, drag is high
      e.pos.addScaledVector(e.vel, dt);
    }
    for (let i = 0; i < this.embers.length && n < this.EMBER_MAX; i++) {
      const e = this.embers[i];
      const k = e.t / e.life;
      // Point the shard along its own velocity so it streaks the way it flies.
      _v.copy(e.vel);
      const spd = _v.length();
      if (spd > 0.001) _q.setFromUnitVectors(_v.set(0, 0, 1), _v.copy(e.vel).divideScalar(spd));
      else _q.identity();
      // Stretch with speed: a fast ember reads as a streak, a slow one as a dot.
      const stretch = 1 + Math.min(spd * 0.05, 3.5);
      _scl.set(e.size, e.size, e.size * stretch);
      _m4.compose(e.pos, _q, _scl);
      mesh.setMatrixAt(n, _m4);
      // Flicker and cool: white-hot when new, dull red as it dies.
      const flick = 0.62 + 0.38 * Math.sin(e.phase + e.t * e.rate);
      const heat = (1 - k) * flick;
      _col.setRGB(
        Math.min(1, 0.55 + heat * 1.2),
        Math.min(1, heat * heat * 0.95),
        Math.min(1, heat * heat * heat * 0.55),
      );
      mesh.setColorAt(n, _col);
      n++;
    }
    mesh.count = n;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  _updateLights(dt) {
    for (const l of this._lights) {
      if (!l.light.visible) continue;
      l.t += dt;
      const k = l.t / l.life;
      if (k >= 1) { l.light.visible = false; l.light.intensity = 0; continue; }
      // Fast rise, long-ish decay: the light peaks before the fireball reaches
      // full size, because the flash is the detonation, not the fire.
      const rise = clamp01(k / 0.08);
      l.light.intensity = l.peak * rise * Math.pow(1 - k, 2.2);
    }
  }

  /** Live counts, for profiling. */
  get counts() {
    return {
      explosions: this.explosions.length, debris: this.debris.length,
      flashes: this.flashes.length, embers: this.embers.length,
      lights: this._lights.filter((l) => l.light.visible).length,
    };
  }
}
