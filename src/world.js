// world.js — low-poly environment: terrain, ocean, islands, mountains, sky, clouds
import * as THREE from 'three';
import { flatMat, enableShadow, mulberry32, rand, pick, clamp, smoothstep, TAU } from './utils.js';
import { createCloud, createTree, createRock } from './models.js';

const WORLD_RADIUS = 2600;     // outer play area radius (enforced softly)
const SEA_LEVEL = 0;

/* ============================================================
   SKY — gradient dome + sun + ambient/hemisphere lighting
   ============================================================ */
export function createSky(scene) {
  const skyGeo = new THREE.SphereGeometry(6000, 24, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      topColor:    { value: new THREE.Color(0x2a6fb0) },
      midColor:    { value: new THREE.Color(0x9ed8f5) },
      bottomColor: { value: new THREE.Color(0xeaf6ff) },
      offset:      { value: 1200 },
      exponent:    { value: 0.7 },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 topColor; uniform vec3 midColor; uniform vec3 bottomColor;
      uniform float offset; uniform float exponent;
      varying vec3 vWorldPos;
      void main(){
        float h = normalize(vWorldPos + vec3(0.0, offset, 0.0)).y;
        float t = max(pow(max(h, 0.0), exponent), 0.0);
        vec3 col = mix(midColor, topColor, t);
        col = mix(bottomColor, col, smoothstep(-0.05, 0.25, h));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);

  // Sun — emissive billboard with glow
  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(160, 24),
    new THREE.MeshBasicMaterial({ color: 0xfff3c0, fog: false })
  );
  sun.position.set(-1800, 1400, -3000);
  sun.lookAt(0, 0, 0);
  scene.add(sun);
  const sunGlow = new THREE.Mesh(
    new THREE.CircleGeometry(320, 24),
    new THREE.MeshBasicMaterial({ color: 0xfff3c0, transparent: true, opacity: 0.25, fog: false, blending: THREE.AdditiveBlending })
  );
  sunGlow.position.copy(sun.position);
  sunGlow.lookAt(0, 0, 0);
  scene.add(sunGlow);

  // Fog — distance haze blends into horizon
  scene.fog = new THREE.Fog(0xbfe3f5, 1400, 4200);
  return { sky, sun, sunGlow };
}

/* ============================================================
   OCEAN — large animated low-poly water plane
   ============================================================ */
export function createOcean(scene) {
  const size = 12000;
  // 212² quads ≈ 90k triangles, up from 80k. The waves are displaced in the
  // vertex shader with analytically derived normals, so a denser grid costs
  // only GPU vertex work — there is no per-frame CPU cost to raising this.
  const segs = 284;
  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  geo.rotateX(-Math.PI / 2);

  // The waves run on the GPU. Displacing 40k vertices in JS every frame was
  // what forced the old low segment count and flat shading; doing it in the
  // vertex shader means the surface can be denser AND smooth-shaded, with the
  // normal derived analytically from the same wave sum so lighting is correct.
  // Opaque on purpose. At 0.94 the transparency was visually free but put a
  // 12000-unit plane into the transparent pass, where it is depth-sorted as a
  // single object against every cloud — a guaranteed source of surfaces
  // punching through each other. Opaque means it writes depth normally.
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2f8fb8,
    flatShading: false,
    metalness: 0.35,
    roughness: 0.22,
  });
  const uniforms = { uTime: { value: 0 } };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        uniform float uTime;
        // Wave height and its analytic gradient, so the normal is exact.
        float waveH(vec2 p){
          return sin(p.x*0.012 + uTime*0.8)*1.6
               + cos(p.y*0.015 - uTime*0.6)*1.2
               + sin((p.x+p.y)*0.020 + uTime*1.1)*0.5
               + sin((p.x*0.7-p.y)*0.041 - uTime*1.7)*0.28;
        }
        vec2 waveG(vec2 p){
          float dx = cos(p.x*0.012 + uTime*0.8)*1.6*0.012
                   + cos((p.x+p.y)*0.020 + uTime*1.1)*0.5*0.020
                   + cos((p.x*0.7-p.y)*0.041 - uTime*1.7)*0.28*0.041*0.7;
          float dy = -sin(p.y*0.015 - uTime*0.6)*1.2*0.015
                   + cos((p.x+p.y)*0.020 + uTime*1.1)*0.5*0.020
                   - cos((p.x*0.7-p.y)*0.041 - uTime*1.7)*0.28*0.041;
          return vec2(dx, dy);
        }
      `)
      .replace('#include <beginnormal_vertex>', `
        vec2 wp = position.xz;
        vec2 g = waveG(wp);
        vec3 objectNormal = normalize(vec3(-g.x, 1.0, -g.y));
      `)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position.x, position.y + waveH(wp), position.z);
      `);
  };
  mat.userData.uniforms = uniforms;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = SEA_LEVEL;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Vertex displacement happens in the shader, so the CPU only advances time.
  // The mesh's bounding volume no longer matches the displaced surface, but the
  // amplitude (~3.6 units on a 12000-unit plane) is far too small to matter for
  // culling, and the plane is effectively always in view anyway.
  return {
    mesh,
    update(t) {
      uniforms.uTime.value = t;
    },
  };
}

/* ============================================================
   VALUE NOISE — tiny homegrown 2D noise for terrain
   ============================================================ */
function hash2(x, z, seed) {
  let n = Math.sin(x * 127.1 + z * 311.7 + seed * 0.13) * 43758.5453;
  return n - Math.floor(n);
}
function smoothNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  return a * (1 - ux) * (1 - uz) + b * ux * (1 - uz) + c * (1 - ux) * uz + d * ux * uz;
}
function fbm(x, z, seed, octaves = 4) {
  let v = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    v += smoothNoise(x * freq, z * freq, seed + i * 17) * amp;
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return v / norm;
}

/* ============================================================
   ISLAND — a single low-poly landmass with hills, beaches, props
   ============================================================ */
// Terrain colour ramp. Stops are blended rather than switched so the shading
// reads as gradation instead of contour lines.
const SAND = new THREE.Color(0xe6d396);
const RAMP = [
  { h: 0.00, c: new THREE.Color(0xc2b070) },  // beach grass
  { h: 0.16, c: new THREE.Color(0x4f9c4a) },  // grass
  { h: 0.38, c: new THREE.Color(0x3d7a38) },  // deep grass
  { h: 0.55, c: new THREE.Color(0x6b5a3a) },  // dirt
  { h: 0.72, c: new THREE.Color(0x7d7f86) },  // rock
  { h: 0.88, c: new THREE.Color(0xf2f6fa) },  // snow
];
const _tc = new THREE.Color();

function terrainColor(h) {
  if (h <= RAMP[0].h) return _tc.copy(RAMP[0].c);
  for (let i = 1; i < RAMP.length; i++) {
    if (h <= RAMP[i].h) {
      const t = (h - RAMP[i - 1].h) / (RAMP[i].h - RAMP[i - 1].h);
      return _tc.copy(RAMP[i - 1].c).lerp(RAMP[i].c, t);
    }
  }
  return _tc.copy(RAMP[RAMP.length - 1].c);
}

/**
 * Radially subdivided disc lying in the XZ plane, wound so faces point +Y.
 * `rings` controls radial detail (hills), `sectors` angular detail (coastline).
 */
function makeDisc(radius, rings, sectors) {
  const verts = [0, 0, 0];
  for (let r = 1; r <= rings; r++) {
    // Bias samples toward the rim, where the coastline detail actually shows.
    const rad = Math.pow(r / rings, 0.85) * radius;
    for (let s = 0; s < sectors; s++) {
      const a = (s / sectors) * TAU;
      verts.push(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    }
  }
  const at = (r, s) => 1 + (r - 1) * sectors + (s % sectors);
  const idx = [];
  for (let s = 0; s < sectors; s++) idx.push(0, at(1, s + 1), at(1, s));
  for (let r = 1; r < rings; r++) {
    for (let s = 0; s < sectors; s++) {
      const A = at(r, s), B = at(r, s + 1);
      const C = at(r + 1, s), D = at(r + 1, s + 1);
      idx.push(A, B, D, A, D, C);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  return geo;
}

function createIsland(cx, cz, radius, seed, propContainer) {
  const group = new THREE.Group();
  group.position.set(cx, SEA_LEVEL, cz);

  // A polar grid, not THREE.CircleGeometry. CircleGeometry is a triangle fan:
  // one centre vertex and a rim, so every interior point of the island is a
  // straight edge between centre and coast — the heightfield below had nothing
  // to displace and every island came out a faceted cone. This gives real
  // interior vertices for the FBM to sculpt.
  // Roughly 3x the previous resolution. Terrain is where extra polygons buy
  // the most realism: the FBM heightfield already describes far more shape than
  // the old grid could sample, so the added vertices resolve real hills and
  // coastline instead of subdividing flat ground. The big island goes from
  // ~4.8k to ~14.4k triangles; small ones scale down, since a 70-unit islet
  // gains nothing from a 15k budget.
  const rings = Math.round(clamp(radius / 3.5, 40, 115));
  const sectors = Math.round(clamp(radius / 1.05, 130, 370));
  const geo = makeDisc(radius, rings, sectors);
  const pos = geo.attributes.position;

  // Carve jagged coastline
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const d = Math.hypot(x, z) / radius;
    const jitter = (smoothNoise(x * 0.02, z * 0.02, seed) - 0.5) * 0.18;
    const r = (1 + jitter) * d;
    if (r > 1) {
      // pull vertex inward to make irregular silhouette
      const k = 1 / Math.max(r, 0.0001);
      pos.setX(i, x * k);
      pos.setZ(i, z * k);
    }
  }

  // Raise interior into hills
  const heights = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const d = Math.hypot(x, z) / radius;
    const land = Math.max(0, 1 - d);
    const hill = fbm(x * 0.01, z * 0.01, seed, 4);
    const peak = fbm(x * 0.04 + 50, z * 0.04 + 50, seed, 3);
    let h = Math.pow(land, 1.5) * (radius * 0.18) * (0.4 + hill);
    h += Math.pow(land, 4) * peak * radius * 0.5; // central peaks
    // Beach flattening near edge
    if (land < 0.12) h *= land / 0.12;
    heights.push(h);
    pos.setY(i, h);
  }
  geo.computeVertexNormals();

  // Vertex colors by height (beach → grass → rock → snow)
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = heights[i] / Math.max(1, radius * 0.4);
    const d = Math.hypot(pos.getX(i), pos.getZ(i)) / radius;
    // Blended bands rather than hard steps — with real interior geometry the
    // steps showed up as contour rings.
    c.copy(terrainColor(h));
    if (d > 0.80) {
      const beach = smoothstep(0.80, 0.93, d);
      c.lerp(SAND, beach);
    }
    // slight per-vertex variation for painterly look
    const j = (hash2(pos.getX(i), pos.getZ(i), seed) - 0.5) * 0.06;
    colors[i * 3] = Math.max(0, Math.min(1, c.r + j));
    colors[i * 3 + 1] = Math.max(0, Math.min(1, c.g + j));
    colors[i * 3 + 2] = Math.max(0, Math.min(1, c.b + j));
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // Smooth-shaded: with a real heightfield underneath, flat shading turned
  // every hill into a mass of hard facets.
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: false, roughness: 0.95, metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  group.add(mesh);

  // Scatter trees & rocks on grassy areas
  if (propContainer) {
    const treeCount = Math.floor(radius * 0.06);
    const rockCount = Math.floor(radius * 0.025);
    for (let i = 0; i < treeCount; i++) {
      const a = hash2(cx + i, cz - i, seed) * TAU;
      const r = Math.sqrt(hash2(cx - i, cz + i, seed + 1)) * radius * 0.8;
      const lx = Math.cos(a) * r, lz = Math.sin(a) * r;
      const ld = Math.hypot(lx, lz) / radius;
      if (ld > 0.8 || ld < 0.1) continue;
      const hLocal = sampleHeightAt(lx, lz, radius, seed);
      if (hLocal < radius * 0.03 || hLocal > radius * 0.25) continue;
      const tree = createTree(mulberry32((seed + i * 31) >>> 0));
      tree.position.set(cx + lx, hLocal, cz + lz);
      const s = 0.8 + (hash2(lx, lz, seed) * 0.7);
      tree.scale.setScalar(s);
      tree.rotation.y = hash2(lx, lz, seed + 9) * TAU;
      propContainer.add(tree);
    }
    for (let i = 0; i < rockCount; i++) {
      const a = hash2(cx - i * 2, cz + i * 3, seed) * TAU;
      const r = Math.sqrt(hash2(cx + i, cz - i, seed + 5)) * radius * 0.85;
      const lx = Math.cos(a) * r, lz = Math.sin(a) * r;
      const ld = Math.hypot(lx, lz) / radius;
      if (ld > 0.9) continue;
      const hLocal = sampleHeightAt(lx, lz, radius, seed);
      const rock = createRock(mulberry32((seed + i * 97) >>> 0));
      rock.position.set(cx + lx, hLocal, cz + lz);
      rock.scale.setScalar(0.7 + hash2(lx, lz, seed + 3) * 1.4);
      rock.rotation.y = hash2(lx, lz, seed + 7) * TAU;
      propContainer.add(rock);
    }
  }

  return { group, mesh };
}

function sampleHeightAt(x, z, radius, seed) {
  const d = Math.hypot(x, z) / radius;
  const land = Math.max(0, 1 - d);
  const hill = fbm(x * 0.01, z * 0.01, seed, 4);
  const peak = fbm(x * 0.04 + 50, z * 0.04 + 50, seed, 3);
  let h = Math.pow(land, 1.5) * (radius * 0.18) * (0.4 + hill);
  h += Math.pow(land, 4) * peak * radius * 0.5;
  if (land < 0.12) h *= land / 0.12;
  return h;
}

/* ============================================================
   CLOUD FIELD — many clouds scattered in a layer
   ============================================================ */
export function createCloudField(scene, count = 60) {
  const group = new THREE.Group();
  const rng = mulberry32(99173);
  for (let i = 0; i < count; i++) {
    const cloud = createCloud(rng, rand(2, 6));
    const a = rng() * TAU;
    const r = 200 + rng() * 2200;
    cloud.position.set(Math.cos(a) * r, 180 + rng() * 320, Math.sin(a) * r);
    cloud.rotation.y = rng() * TAU;
    const s = rand(0.7, 1.6);
    cloud.scale.setScalar(s);
    cloud.userData.driftSpeed = rand(2, 8);
    cloud.userData.driftDir = a;
    group.add(cloud);
  }
  scene.add(group);
  return group;
}

/* ============================================================
   WORLD — assemble islands + ocean + sky + clouds
   ============================================================ */
export function createWorld(scene) {
  const props = new THREE.Group();   // trees/rocks live here
  const islandsGroup = new THREE.Group();
  scene.add(islandsGroup, props);

  const islands = [];
  const seed = 1337;

  // Central large island
  islands.push(createIsland(0, 0, 380, seed, props));
  // Ring of medium islands
  const ringCount = 6;
  for (let i = 0; i < ringCount; i++) {
    const a = (i / ringCount) * TAU + 0.3;
    const r = 1100;
    const rad = rand(160, 280);
    const isl = createIsland(Math.cos(a) * r, Math.sin(a) * r, rad, seed + i * 101, props);
    islands.push(isl);
  }
  // Scattered small islands
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * TAU;
    const r = 400 + Math.random() * 1500;
    const rad = rand(70, 140);
    const isl = createIsland(Math.cos(a) * r, Math.sin(a) * r, rad, seed + i * 211 + 7, props);
    islands.push(isl);
  }

  for (const isl of islands) islandsGroup.add(isl.group);

  enableShadow(props, true, false);

  const sky = createSky(scene);
  const ocean = createOcean(scene);
  const clouds = createCloudField(scene, 70);

  return {
    sky, ocean, clouds, islands, props,
    radius: WORLD_RADIUS,
    seaLevel: SEA_LEVEL,
    update(t, dt) {
      ocean.update(t);
      // Cloud drift
      for (const c of clouds.children) {
        const d = c.userData.driftSpeed * dt;
        c.position.x += Math.cos(c.userData.driftDir) * d;
        c.position.z += Math.sin(c.userData.driftDir) * d;
        // wrap around
        if (Math.hypot(c.position.x, c.position.z) > 2600) {
          c.userData.driftDir += Math.PI;
        }
      }
    },
  };
}
