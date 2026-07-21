// models.js — facade over the Blender-exported .glb asset cache.
// Originally these functions built geometry in code; now they hand out
// clones of assets authored in Blender (see blender/build_*.py) and
// exported to assets/models/*.glb. The runtime hooks (afterburners,
// rotors, nav lights) are discovered by name from the glb hierarchy.
//
// Each exported glb has a root node whose rotation orients the model so
// forward = +Z, up = +Y (matching the existing flight code). We wrap each
// clone in an outer THREE.Group that starts at identity — so the player
// & enemy code can keep treating the returned object's quaternion as the
// "orientation" without the glb's baked root rotation leaking in.
import * as THREE from 'three';
import { get, getLOD, collectAircraftHooks, setupShadows, cloneMaterials } from './assets.js';

/** Wrap a glb clone in an identity-transform group. */
function wrap(glbClone) {
  const wrapper = new THREE.Group();
  wrapper.add(glbClone);
  return wrapper;
}

// Switch distances for aircraft hulls. Generous compared with the scenery: an
// aircraft is the thing you are looking at, and a bandit at 400 units is still
// a meaningful silhouette, so the full hull is held well past the point where a
// tree would have dropped.
const AIRFRAME_LOD_DISTANCES = [0, 260, 700];

/**
 * Collapse "Airframe" / "Airframe_LOD1" / "Airframe_LOD2" into a THREE.LOD.
 *
 * The animated parts — flames, engine glows, nav lights, rotors — are left
 * exactly where they are, as siblings outside the LOD, so the hooks the game
 * looks up by name still resolve and still render at any range. Only the hull
 * swaps. Without this every bandit on screen costs a full 90k-triangle hull no
 * matter how far away it is.
 */
function applyAirframeLOD(root) {
  // Match on the node, NOT on isMesh. A merged airframe carries one primitive
  // per material, and GLTFLoader represents a multi-primitive mesh as a Group
  // of Meshes — so the node called "Airframe" is a Group and an isMesh test
  // silently finds nothing, leaving every aircraft at full detail.
  const levels = [];
  root.traverse((o) => {
    if (!o.name) return;
    const m = /^Airframe(?:_LOD(\d+))?$/.exec(o.name);
    if (m) levels[m[1] ? Number(m[1]) : 0] = o;
  });
  if (levels.length < 2 || !levels[0]) return root;   // no chain baked in

  const parent = levels[0].parent;
  const lod = new THREE.LOD();
  lod.position.copy(levels[0].position);
  lod.quaternion.copy(levels[0].quaternion);
  lod.scale.copy(levels[0].scale);

  levels.forEach((mesh, i) => {
    if (!mesh || !mesh.parent) return;
    mesh.parent.remove(mesh);
    // The LOD carries the transform now, so each level sits at its origin.
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    lod.addLevel(mesh, AIRFRAME_LOD_DISTANCES[i] ?? i * 400);
  });
  parent.add(lod);
  return root;
}

/** Player jet — must call loadAll() first. */
export function createPlayerJet() {
  const root = wrap(get('playerJet'));
  applyAirframeLOD(root);
  setupShadows(root, true, false);
  const hooks = collectAircraftHooks(root);
  root.userData.afterburners = hooks.afterburners;
  root.userData.engineGlows  = hooks.engineGlows;
  // Nav lights: tag each with blink phase + base color from its material
  root.userData.navLights = hooks.navLights.map((mesh, i) => ({
    mesh,
    base: mesh.material && mesh.material.color ? mesh.material.color.getHex() : 0xffffff,
    blink: i * Math.PI,
  }));
  // Afterburner: each nozzle gets a stack of nested cones instead of one.
  // A single cone can only fade in and out; a stack can have each stage
  // flicker, scale and shift colour independently, which is what actually
  // reads as combustion rather than a translucent triangle.
  root.userData.flameStages = [];
  for (const f of hooks.afterburners) {
    if (!f.material) continue;
    f.material = f.material.clone();
    f.material.transparent = true;
    f.material.opacity = 0;
    f.material.blending = THREE.AdditiveBlending;
    f.material.depthWrite = false;
    f.material.toneMapped = false;      // let the core blow out to white
    f.renderOrder = 5;

    // Inner core + outer plume, built from the exported cone so they inherit
    // its position and orientation on the airframe.
    const stages = [{ mesh: f, mat: f.material, phase: Math.random() * 6.28,
                      widthMul: 1.0, lenMul: 1.0, hue: 0.58, intensity: 1.0 }];
    for (const spec of [
      { widthMul: 0.55, lenMul: 0.55, hue: 0.55, intensity: 1.6 },   // hot core
      { widthMul: 1.55, lenMul: 1.45, hue: 0.07, intensity: 0.55 },  // orange plume
    ]) {
      const m = f.clone();
      m.material = f.material.clone();
      m.material.toneMapped = false;
      m.renderOrder = 5;
      f.parent.add(m);
      stages.push({ mesh: m, mat: m.material, phase: Math.random() * 6.28, ...spec });
    }
    root.userData.flameStages.push(stages);
  }

  // Engine glow discs sit behind the flame and pulse with it.
  for (const g of hooks.engineGlows) {
    if (!g.material) continue;
    g.material = g.material.clone();
    g.material.transparent = true;
    g.material.blending = THREE.AdditiveBlending;
    g.material.depthWrite = false;
    g.material.toneMapped = false;
  }
  return root;
}

/** Enemy jet — palette is baked into the glb; we just clone it. */
export function createEnemyJet(_palette) {
  const root = wrap(get('enemyJet'));
  applyAirframeLOD(root);
  cloneMaterials(root);            // per-instance so hit-flash doesn't bleed across enemies
  setupShadows(root, true, false);
  const hooks = collectAircraftHooks(root);
  root.userData.engineGlows = hooks.engineGlows;
  return root;
}

/** Helicopter — rotor hooks wired for per-frame spin. */
export function createHelicopter(_palette) {
  const root = wrap(get('helicopter'));
  applyAirframeLOD(root);
  cloneMaterials(root);            // per-instance emissive for hit-flash
  setupShadows(root, true, false);
  const hooks = collectAircraftHooks(root);
  root.userData.rotor = hooks.rotor;
  root.userData.tailRotor = hooks.tailRotor;
  return root;
}

/** Missile (player) — loaded as a glb. */
export function createMissile() {
  const root = wrap(get('missile'));
  setupShadows(root, false, false);
  return root;
}

// ---- Environment props ----
// These are instanced ~225x across the archipelago, so each returns a THREE.LOD
// built from the chain baked into the glb. The renderer swaps levels itself
// during projectObject — nothing to drive from the game loop. Full 10k detail
// is only ever paid for on the few props near the camera; the rest run at
// ~760 or ~200 triangles.
function prop(name) {
  const lod = getLOD(name);
  return lod || wrap(get(name));   // fall back if a glb ships without a chain
}

export function createCloud(_rng, _scale) {
  return prop('cloud');
}
export function createTree(_rng) {
  return prop('tree');
}
export function createRock(_rng) {
  return prop('rock');
}
