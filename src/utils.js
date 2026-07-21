// utils.js — shared math, RNG, and small helpers
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (v) => clamp(v, 0, 1);
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const rand = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// Simple deterministic-ish PRNG (mulberry32) so world gen is repeatable per seed
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reusable temp vectors to avoid GC churn
export const tmp = {
  v1: new THREE.Vector3(),
  v2: new THREE.Vector3(),
  v3: new THREE.Vector3(),
  q1: new THREE.Quaternion(),
  q2: new THREE.Quaternion(),
  m1: new THREE.Matrix4(),
};

// Distance² on XZ plane
export const dist2XZ = (a, b) => {
  const dx = a.x - b.x, dz = a.z - b.z;
  return dx * dx + dz * dz;
};

// Flat-shaded material factory — Blender-style solid low-poly look
export function flatMat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    metalness: opts.metalness ?? 0.1,
    roughness: opts.roughness ?? 0.85,
    ...opts,
  });
}

// Build a flat-shaded low-poly mesh from a BufferGeometry, computing proper normals
export function flatMesh(geo, material) {
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  return mesh;
}

// Make a material non-shadow-receiving helper flag
export const enableShadow = (obj, cast = true, receive = true) => {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
  return obj;
};
