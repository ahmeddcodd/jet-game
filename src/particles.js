// particles.js — GPU-light particle effects: explosions, smoke, sparks, debris
import * as THREE from 'three';
import { rand, tmp } from './utils.js';

/* ============================================================
   ParticleField — pooled points-based emitter
   ============================================================ */
export class ParticleField {
  constructor(scene, max = 600) {
    this.max = max;
    this.particles = [];
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(max * 3);
    this.colors = new Float32Array(max * 3);
    this.sizes = new Float32Array(max);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      uniforms: { uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) } },
      vertexShader: `
        attribute float size;
        // NOTE: 'attribute vec3 color' is injected by three because
        // vertexColors is true — redeclaring it is a GLSL redefinition error.
        varying vec3 vColor;
        uniform float uPixelRatio;
        void main(){
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = size * uPixelRatio * (300.0 / -mv.z);
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor, a);
        }`,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this._geo = geo;
  }

  // Spawn a single particle
  _spawn(pos, vel, color, size, life, drag = 1.2, gravity = 0) {
    if (this.particles.length >= this.max) return;
    this.particles.push({
      pos: pos.clone(), vel: vel.clone(), color: color.clone(),
      size, life, maxLife: life, drag, gravity,
    });
  }

  // Burst explosion: fireball + sparks + smoke
  explosion(pos, scale = 1) {
    const n = Math.floor(40 * scale);
    for (let i = 0; i < n; i++) {
      const dir = randomDir();
      const speed = rand(8, 40) * scale;
      const col = new THREE.Color().setHSL(0.06 + Math.random() * 0.06, 1, 0.55);
      this._spawn(pos, dir.multiplyScalar(speed), col, rand(2, 5) * scale, rand(0.4, 0.9), 2.5, -5);
    }
    // White-hot core
    for (let i = 0; i < 12 * scale; i++) {
      const dir = randomDir();
      this._spawn(pos, dir.multiplyScalar(rand(20, 60) * scale), new THREE.Color(0xffffcc), rand(3, 6) * scale, rand(0.2, 0.4), 3, 0);
    }
    // Smoke
    for (let i = 0; i < 18 * scale; i++) {
      const dir = randomDir();
      dir.y = Math.abs(dir.y) * 0.8 + 0.2;
      const col = new THREE.Color().setHSL(0, 0, 0.25 + Math.random() * 0.3);
      this._spawn(pos, dir.multiplyScalar(rand(4, 16) * scale), col, rand(4, 9) * scale, rand(1.2, 2.4), 1.2, -2);
    }
    // Sparks
    for (let i = 0; i < 24 * scale; i++) {
      const dir = randomDir();
      this._spawn(pos, dir.multiplyScalar(rand(30, 80) * scale), new THREE.Color(0xffcc55), rand(1, 2), rand(0.5, 1.0), 1.5, -20);
    }
  }

  // Small hit puff (bullet impact)
  hitSpark(pos, normal) {
    for (let i = 0; i < 6; i++) {
      const dir = normal.clone().multiplyScalar(rand(2, 6)).add(randomDir().multiplyScalar(rand(4, 14)));
      this._spawn(pos, dir, new THREE.Color(0xffdd88), rand(1.2, 2.4), rand(0.2, 0.4), 2, -8);
    }
  }

  // Smoke trail puff (for damaged enemies / missiles)
  smokePuff(pos, color = 0x888888) {
    const dir = new THREE.Vector3(rand(-1, 1), rand(0.5, 2), rand(-1, 1));
    this._spawn(pos, dir, new THREE.Color(color).multiplyScalar(0.6 + Math.random() * 0.4), rand(2, 4), rand(0.6, 1.2), 1.2, -1);
  }

  update(dt) {
    const arr = this.positions;
    const colArr = this.colors;
    const sizeArr = this.sizes;
    let write = 0;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      // physics
      p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);

      const k = p.life / p.maxLife;
      const idx = write * 3;
      arr[idx] = p.pos.x;
      arr[idx + 1] = p.pos.y;
      arr[idx + 2] = p.pos.z;
      const fade = k;
      colArr[idx] = p.color.r * fade;
      colArr[idx + 1] = p.color.g * fade;
      colArr[idx + 2] = p.color.b * fade;
      sizeArr[write] = p.size * (0.3 + k * 0.7);
      write++;
    }
    this._geo.setDrawRange(0, write);
    this._geo.attributes.position.needsUpdate = true;
    this._geo.attributes.color.needsUpdate = true;
    this._geo.attributes.size.needsUpdate = true;
  }
}

function randomDir() {
  // uniform on sphere
  const u = Math.random(), v = Math.random();
  const theta = u * Math.PI * 2;
  const phi = Math.acos(2 * v - 1);
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.sin(phi) * Math.sin(theta),
    Math.cos(phi),
  );
}
