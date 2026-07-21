// assets.js — async loader for the Blender-exported .glb models.
// All assets are built in Blender (see blender/*.py) and exported to
// public/assets/models/*.glb. This module loads them once, caches the scene
// roots, and hands out clones to the game.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Served straight out of public/, so the URL mirrors the folder. BASE_URL keeps
// this correct when the built game is hosted from a subpath.
const MODEL_BASE = `${import.meta.env.BASE_URL}assets/models/`;
const cache = new Map();

// The models are Draco-compressed at export (blender/bpy_helpers.py). The
// decoder is bundled from node_modules into public/draco rather than pulled
// from a CDN, so the game still loads offline and from any origin.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

// Map of asset name -> filename. Asset names are the keys the game uses.
const ASSETS = {
  playerJet: 'player_jet.glb',
  enemyJet: 'enemy_jet.glb',
  helicopter: 'helicopter.glb',
  missile: 'missile.glb',
  tree: 'tree.glb',
  rock: 'rock.glb',
  cloud: 'cloud.glb',
  vfxExplosion: 'vfx_explosion.glb',
  vfxDebris: 'vfx_debris.glb',
  vfxMuzzle: 'vfx_muzzle.glb',
};

// Track loading progress for UI
let _totalAssets = Object.keys(ASSETS).length;
let _loadedCount = 0;
let _progressCb = null;

export function onProgress(cb) { _progressCb = cb; }

export function loadStatus() {
  return { loaded: _loadedCount, total: _totalAssets };
}

/** Load all known assets; resolves once every glb is in the cache. */
export async function loadAll() {
  const entries = Object.entries(ASSETS);
  _totalAssets = entries.length;
  _loadedCount = 0;
  await Promise.all(entries.map(async ([name, file]) => {
    const gltf = await loader.loadAsync(MODEL_BASE + file);
    cache.set(name, gltf.scene);
    _loadedCount++;
    if (_progressCb) _progressCb(_loadedCount, _totalAssets);
  }));
}

/** Returns a clone of the cached asset scene. Throws if not loaded. */
export function get(name) {
  const src = cache.get(name);
  if (!src) throw new Error(`Asset not loaded: ${name}`);
  const clone = src.clone(true);
  // Re-share materials by reference (clone(true) already does, but ensure
  // emissive animation hooks can mutate per-instance by giving each instance
  // its own material ref where needed).
  return clone;
}

/**
 * Switch distances (world units) per LOD level, tuned to this world's scale:
 * play area radius 2600, flight speeds 35-220 u/s, trees ~4-8u tall.
 *
 * Smaller props drop detail sooner because they cover less screen space at the
 * same distance. Clouds hold LOD0 longer — the player flies through them.
 */
const LOD_DISTANCES = {
  tree:  [0, 120, 320, 800],
  rock:  [0, 90, 240, 650],
  cloud: [0, 200, 550, 1200],
};

/**
 * Build a THREE.LOD from an asset whose glb contains "<Name>_LOD0..3" holder
 * nodes. Returns null if the asset has no chain, so callers can fall back.
 *
 * The renderer calls LOD.update() itself during projectObject, so nothing has
 * to be driven per frame from the game loop.
 */
export function getLOD(name) {
  const src = cache.get(name);
  if (!src) throw new Error(`Asset not loaded: ${name}`);

  const levels = [];
  for (const child of src.children) {
    const m = /_LOD(\d+)$/.exec(child.name);
    if (m) levels[Number(m[1])] = child;
  }
  if (!levels.length) return null;

  const dists = LOD_DISTANCES[name] || [0, 120, 320, 800];
  const lod = new THREE.LOD();
  levels.forEach((node, i) => {
    if (!node) return;
    // clone(true) shares geometry and material references across instances, so
    // 100 trees cost one copy of each LOD's buffers, not 100.
    lod.addLevel(node.clone(true), dists[i] ?? i * 300);
  });
  return lod;
}

/**
 * Find the first descendant (by name) of a root whose name matches.
 * Recursive case-insensitive contains match.
 */
export function findByName(root, name) {
  let found = null;
  const target = name.toLowerCase();
  root.traverse((o) => {
    if (!found && o.name && o.name.toLowerCase().includes(target)) found = o;
  });
  return found;
}

/** Find all descendants whose name contains the given substring. */
export function findAllByName(root, name) {
  const out = [];
  const target = name.toLowerCase();
  root.traverse((o) => {
    if (o.name && o.name.toLowerCase().includes(target)) out.push(o);
  });
  return out;
}

/**
 * Collect animation hooks on a cloned aircraft model.
 * Names match what the Blender build scripts placed:
 *   - Player jet: "Flame" (afterburners), "Glow" (engine glow), "Nav" (lights)
 *   - Helicopter: "Rotor" (main), "TailRotor"
 */
export function collectAircraftHooks(root) {
  // "TailRotor" also contains "rotor", so resolve the tail first and exclude it
  // (and anything under it) when looking for the main rotor. Relying on
  // traversal order here silently breaks if the Blender build reorders parts.
  const tailRotor = findByName(root, 'tailrotor');
  let rotor = null;
  root.traverse((o) => {
    if (rotor || !o.name || !o.name.toLowerCase().includes('rotor')) return;
    if (tailRotor && (o === tailRotor || isDescendantOf(o, tailRotor))) return;
    rotor = o;
  });
  return {
    afterburners: findAllByName(root, 'flame'),
    engineGlows:  findAllByName(root, 'glow'),
    navLights:    findAllByName(root, 'nav'),
    rotor,
    tailRotor,
  };
}

function isDescendantOf(node, ancestor) {
  for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/** Make all meshes in a subtree cast/receive shadows. */
export function setupShadows(root, cast = true, receive = true) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
  return root;
}

/**
 * Deep-clone every material in the subtree so this instance can mutate
 * materials (e.g. hit-flash emissive) without affecting other clones that
 * share the same cached source glb. Call once right after get().
 */
export function cloneMaterials(root) {
  root.traverse((o) => {
    if (o.isMesh && o.material) {
      // a mesh may have an array of materials
      if (Array.isArray(o.material)) {
        o.material = o.material.map((m) => m.clone());
      } else {
        o.material = o.material.clone();
      }
    }
  });
  return root;
}
