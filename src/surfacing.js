// surfacing.js — procedural PBR surfacing: environment reflections and
// triplanar detail maps.
//
// Until now every material was a flat colour with a constant roughness and no
// maps at all. Two consequences, both of which read as "not real":
//
//   1. metalness did nothing. A metal surface is almost entirely *reflection*,
//      and with no environment to reflect, raising metalness only made things
//      darker. The jets were shiny-looking plastic.
//   2. every surface responded to light identically across its whole area, so
//      a wing panel and a canopy frame shaded the same way. Real surfaces vary
//      at millimetre scale, and that variation is most of what the eye reads
//      as material.
//
// Both are fixed here without adding a single byte of download: the textures
// are drawn into canvases at load time, and the environment is generated from
// the same sky colours the scene already uses.
import * as THREE from 'three';

/* ---------------------------------------------------------------------------
   Procedural texture generation
--------------------------------------------------------------------------- */

/** Deterministic value noise so a rebuild always produces the same surface. */
function hash(x, y, seed) {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function smoothNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

function fbm(x, y, seed, octaves = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    v += smoothNoise(x * f, y * f, seed + i) * amp;
    amp *= 0.5; f *= 2;
  }
  return v;
}

/**
 * Height field for hard-surface panelling: plate seams, fastener rows, a fine
 * machining grain and a few long scratches. Returned as a Float32Array so the
 * normal conversion below can work at full precision.
 */
function panelHeight(size, seed) {
  const h = new Float32Array(size * size);
  const cell = size / 8;              // panel size in texels
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0.5;
      // Machining grain — fine, directional.
      v += (fbm(x * 0.35, y * 0.09, seed, 3) - 0.5) * 0.10;
      v += (fbm(x * 0.02, y * 0.02, seed + 9, 4) - 0.5) * 0.18;  // broad weathering

      // Plate seams: a recessed line wherever we cross a cell boundary. The
      // boundaries are jittered per row/column so the grid never reads as a
      // repeating chequer.
      const jx = Math.floor(x / cell), jy = Math.floor(y / cell);
      const ox = hash(jx, jy, seed) * cell * 0.35;
      const oy = hash(jy, jx, seed + 3) * cell * 0.35;
      const dx = Math.min((x + ox) % cell, cell - ((x + ox) % cell));
      const dy = Math.min((y + oy) % cell, cell - ((y + oy) % cell));
      const seam = Math.min(dx, dy);
      if (seam < 1.6) v -= (1.6 - seam) * 0.22;

      // Fastener rows just inside each seam.
      const fx = (x + ox) % cell, fy = (y + oy) % cell;
      if (fy > 3 && fy < 5.2 && Math.abs((fx % 7) - 3.5) < 1.0) v -= 0.16;
      if (fx > 3 && fx < 5.2 && Math.abs((fy % 7) - 3.5) < 1.0) v -= 0.16;

      h[y * size + x] = v;
    }
  }
  // Scratches — long, thin, shallow.
  for (let s = 0; s < 26; s++) {
    let px = hash(s, 1, seed) * size, py = hash(s, 2, seed) * size;
    const a = hash(s, 3, seed) * Math.PI * 2;
    const len = 25 + hash(s, 4, seed) * size * 0.5;
    const dxs = Math.cos(a), dys = Math.sin(a);
    for (let i = 0; i < len; i++) {
      const ix = Math.floor(px) & (size - 1), iy = Math.floor(py) & (size - 1);
      h[iy * size + ix] += 0.07;
      px += dxs; py += dys;
    }
  }
  return h;
}

/** Convert a height field to a tangent-space normal map texture (Sobel). */
function heightToNormal(h, size, strength) {
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // n = normalize(-dx, -dy, 1)
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i]     = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Channel-packed ORM-style map: R = ambient occlusion, G = roughness variation,
 * B = metalness variation. One fetch and one upload serves three properties.
 */
function packedORM(h, size, seed) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const height = h[y * size + x];
      // Recessed texels are occluded — seams and fastener heads go darker.
      const ao = Math.max(0, Math.min(1, 0.55 + (height - 0.5) * 1.6));
      // Roughness: weathered patches are duller, scratches are shinier.
      const rough = Math.max(0, Math.min(1,
        0.5 + (fbm(x * 0.015, y * 0.015, seed + 21, 4) - 0.5) * 1.1
            - (height - 0.5) * 0.5));
      // Metalness: paint wears through on high points, exposing bare metal.
      const metal = Math.max(0, Math.min(1, (height - 0.56) * 3.2));
      data[i] = Math.round(ao * 255);
      data[i + 1] = Math.round(rough * 255);
      data[i + 2] = Math.round(metal * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Organic height field for ground and rock: layered noise with a ridged octave
 * for erosion channels. No seams, no fasteners — a hard-surface panel pattern
 * on a hillside reads as obviously wrong, so terrain gets its own map rather
 * than sharing the airframe's.
 */
function organicHeight(size, seed) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0.5;
      v += (fbm(x * 0.055, y * 0.055, seed, 5) - 0.5) * 0.55;   // coarse lumps
      v += (fbm(x * 0.22, y * 0.22, seed + 5, 4) - 0.5) * 0.28;  // gravel
      // Ridged octave — |noise| inverted gives creases that read as erosion.
      const r = 1 - Math.abs(fbm(x * 0.09, y * 0.09, seed + 11, 3) * 2 - 1);
      v -= r * r * 0.22;
      h[y * size + x] = v;
    }
  }
  return h;
}

let _cache = null;
let _organic = null;

/** Build (once) the shared hard-surface detail maps. */
export function detailMaps(size = 512) {
  if (_cache) return _cache;
  const h = panelHeight(size, 7);
  _cache = {
    normal: heightToNormal(h, size, 34),
    orm: packedORM(h, size, 7),
  };
  return _cache;
}

/** Build (once) the shared organic (ground/rock) detail maps. */
export function organicMaps(size = 512) {
  if (_organic) return _organic;
  const h = organicHeight(size, 3);
  _organic = {
    normal: heightToNormal(h, size, 26),
    orm: packedORM(h, size, 3),
  };
  return _organic;
}

/* ---------------------------------------------------------------------------
   Camouflage and markings
--------------------------------------------------------------------------- */

/**
 * Camouflage, generated by DOMAIN WARPING rather than plain noise.
 *
 * Sampling fbm at a position that has itself been displaced by another fbm
 * stretches the blobs into flowing, interlocking bands — the elongated
 * tiger-stripe shape of real disruptive camo. Plain thresholded noise gives
 * round islands that read as spots, which is the giveaway of a procedural
 * pattern.
 */
function camoTexture(size, palette, seed) {
  const data = new Uint8Array(size * size * 4);
  const cols = palette.map((h) => new THREE.Color(h));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Warp the sample position, then sample again — the double lookup is
      // what produces flow rather than blobs.
      const wx = fbm(x * 0.012, y * 0.012, seed + 31, 4) * 46;
      const wy = fbm(x * 0.012 + 5.2, y * 0.012 + 1.3, seed + 47, 4) * 46;
      // Anisotropic: stretched ~2.5x along X so bands run down the airframe.
      const v = fbm((x + wx) * 0.0075, (y + wy) * 0.019, seed, 5);

      // Hard-ish edges. Real camo is sprayed but the transitions are tight
      // relative to the patch size, so a narrow smoothstep beats a gradient.
      let c;
      if (v < 0.42) c = cols[0];
      else if (v < 0.52) c = cols[0].clone().lerp(cols[1], (v - 0.42) / 0.10);
      else if (v < 0.68) c = cols[1];
      else if (v < 0.74) c = cols[1].clone().lerp(cols[2], (v - 0.68) / 0.06);
      else c = cols[2];

      // Sun-bleaching and grime, so no two areas of the same patch match.
      const wear = 0.86 + fbm(x * 0.03, y * 0.03, seed + 77, 3) * 0.28;
      const i = (y * size + x) * 4;
      data[i]     = Math.min(255, Math.round(c.r * 255 * wear));
      data[i + 1] = Math.min(255, Math.round(c.g * 255 * wear));
      data[i + 2] = Math.min(255, Math.round(c.b * 255 * wear));
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Insignia sheet: four emblems in a 2x2 grid, drawn on a Canvas.
 *
 * Kept to bold geometric shapes with heavy contrast, because these are only
 * ever seen at chase-camera range or in a fast pass — fine detail would
 * dissolve into noise, while a strong silhouette still reads.
 *
 *   0,0 roundel   1,0 star
 *   0,1 chevrons  1,1 hazard stripes
 */
function markingsTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  const h = size / 2;

  // Roundel
  const rx = h * 0.5, ry = h * 0.5, rr = h * 0.36;
  for (const [rad, col] of [[rr, '#20304a'], [rr * 0.66, '#e8e4d8'], [rr * 0.32, '#a8302c']]) {
    g.fillStyle = col; g.beginPath(); g.arc(rx, ry, rad, 0, Math.PI * 2); g.fill();
  }
  // Star
  const sx = h + h * 0.5, sy = h * 0.5, sr = h * 0.38;
  g.fillStyle = '#e8e4d8';
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const r = i % 2 ? sr * 0.42 : sr;
    i ? g.lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r)
      : g.moveTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r);
  }
  g.closePath(); g.fill();
  // Chevrons
  g.strokeStyle = '#e8e4d8'; g.lineWidth = size * 0.035; g.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const y0 = h + h * 0.28 + i * h * 0.22;
    g.beginPath();
    g.moveTo(h * 0.18, y0); g.lineTo(h * 0.5, y0 - h * 0.16); g.lineTo(h * 0.82, y0);
    g.stroke();
  }
  // Hazard stripes
  g.save();
  g.beginPath(); g.rect(h, h, h, h); g.clip();
  g.fillStyle = '#1a1a1a'; g.fillRect(h, h, h, h);
  g.fillStyle = '#d8b33a';
  for (let i = -2; i < 10; i++) {
    g.save(); g.translate(h + i * h * 0.2, h); g.rotate(-0.5);
    g.fillRect(0, -h * 0.3, h * 0.1, h * 2); g.restore();
  }
  g.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Livery palettes. Player and enemy stay visually distinct on purpose —
 *  telling friend from foe at a glance matters more than either looking good. */
export const LIVERY = {
  // Desert tiger stripe, after the reference: sand base, brown and near-navy.
  desert: { palette: [0xb9a279, 0x6d5638, 0x2c2b33], scale: 0.16, emblem: 0 },
  // Cool grey-blue air-superiority scheme, so the player reads as "ours".
  splinter: { palette: [0x7f8b9c, 0x4a5566, 0x2b3340], scale: 0.14, emblem: 1 },
};

let _camoCache = new Map();
let _markCache = null;

export function camoMaps(name) {
  if (!_camoCache.has(name)) {
    const l = LIVERY[name] || LIVERY.desert;
    _camoCache.set(name, camoTexture(512, l.palette, name === 'desert' ? 11 : 29));
  }
  return _camoCache.get(name);
}
export function markingsMap() {
  if (!_markCache) _markCache = markingsTexture(256);
  return _markCache;
}

/* ---------------------------------------------------------------------------
   Environment
--------------------------------------------------------------------------- */

/**
 * A sky environment for reflections, generated from the scene's own palette.
 *
 * This is what actually makes metal look like metal: a metallic surface shows
 * almost nothing but its surroundings, so without an environment map the
 * material had nothing to work with and metalness only darkened it.
 */
export function makeSkyEnvironment(renderer) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');

  // Vertical sky gradient matching the dome in world.js.
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0.00, '#1d5fa8');
  grad.addColorStop(0.42, '#6fc0ec');
  grad.addColorStop(0.52, '#dff0ff');
  grad.addColorStop(0.60, '#8fbcd6');   // horizon haze
  grad.addColorStop(1.00, '#2d5f78');   // sea below
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Sun. The specular hotspot it puts on the hull is a large part of reading
  // a surface as curved and hard rather than flat and matte.
  const sx = size * 0.24, sy = size * 0.3;
  const sun = ctx.createRadialGradient(sx, sy, 0, sx, sy, size * 0.20);
  sun.addColorStop(0, 'rgba(255,252,235,1)');
  sun.addColorStop(0.18, 'rgba(255,246,208,0.85)');
  sun.addColorStop(1, 'rgba(255,240,200,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

/* ---------------------------------------------------------------------------
   Triplanar detail shader patch
--------------------------------------------------------------------------- */

/**
 * Add triplanar detail normal + roughness/metalness/AO to a MeshStandardMaterial.
 *
 * Triplanar rather than UV-mapped on purpose. These meshes DO carry UVs, but
 * they were inherited from primitives and then survived joining, three passes
 * of panel insetting and a decimation down to budget — they overlap and stretch
 * arbitrarily, so any detail sampled through them would smear and seam.
 * Projecting from the three object axes and blending by the normal needs no UVs
 * at all and cannot seam.
 *
 * `scale` is in object units, so a value of 1 means the panel pattern repeats
 * once per unit — tune per asset class, not per model.
 */
export function applyDetailSurfacing(material, {
  scale = 0.55, normalStrength = 1.0, roughAmount = 0.45, metalAmount = 0.0,
  aoAmount = 0.6, organic = false, livery = null,
} = {}) {
  if (!material || material.userData.__surfaced) return material;
  const maps = organic ? organicMaps() : detailMaps();
  material.userData.__surfaced = true;

  const l = livery ? (LIVERY[livery] || LIVERY.desert) : null;
  const uniforms = {
    uCamo: { value: l ? camoMaps(livery) : null },
    uMarks: { value: l ? markingsMap() : null },
    uCamoScale: { value: l ? l.scale : 0.15 },
    uEmblem: { value: l ? l.emblem : 0 },
    uDetailNormal: { value: maps.normal },
    uDetailORM: { value: maps.orm },
    uDetailScale: { value: scale },
    uDetailNormalStrength: { value: normalStrength },
    uDetailRough: { value: roughAmount },
    uDetailMetal: { value: metalAmount },
    uDetailAO: { value: aoAmount },
  };

  // Every surfaced material emits identical shader source, so they must share
  // one program. Without a stable cache key three compiles a fresh program per
  // material instance — and enemies clone their materials per aircraft, so a
  // full wave would have meant a dozen redundant compiles and program switches.
  // The camo branch is compiled in only when a livery is set, so untextured
  // surfaces (terrain, scenery) never pay for the extra samples.
  if (l) {
    material.defines = material.defines || {};
    material.defines.USE_CAMO = '';
  }
  material.customProgramCacheKey = () =>
    (organic ? 'surfaced-organic-v1' : 'surfaced-panel-v1') + (l ? '-camo' : '');
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vDetailPos;
        varying vec3 vDetailNrm;
      `)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vDetailPos = position;
        vDetailNrm = normal;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vDetailPos;
        varying vec3 vDetailNrm;
        uniform sampler2D uDetailNormal;
        uniform sampler2D uDetailORM;
        uniform float uDetailScale;
        uniform float uDetailNormalStrength;
        uniform float uDetailRough;
        uniform float uDetailMetal;
        uniform float uDetailAO;
        #ifdef USE_CAMO
        uniform sampler2D uCamo;
        uniform sampler2D uMarks;
        uniform float uCamoScale;
        uniform float uEmblem;
        #endif

        // Blend weights from the surface normal, sharpened so the transition
        // between projections is narrow enough not to look like a smear.
        vec3 triWeights(vec3 n){
          vec3 b = pow(abs(n), vec3(5.0));
          return b / max(b.x + b.y + b.z, 1e-4);
        }
        vec4 triSample(sampler2D t, vec3 p, vec3 w){
          return texture2D(t, p.zy) * w.x
               + texture2D(t, p.xz) * w.y
               + texture2D(t, p.xy) * w.z;
        }
      `)
      // Perturb the shading normal AFTER three has built it, so this composes
      // with flat shading and with whatever the geometry already provides.
      .replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        {
          vec3 p = vDetailPos * uDetailScale;
          vec3 w = triWeights(normalize(vDetailNrm));
          vec3 dn = triSample(uDetailNormal, p, w).xyz * 2.0 - 1.0;
          // Build a basis around the existing normal to apply the detail in.
          vec3 up = abs(normal.y) < 0.99 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
          vec3 tX = normalize(cross(up, normal));
          vec3 tY = cross(normal, tX);
          normal = normalize(normal + (tX * dn.x + tY * dn.y) * uDetailNormalStrength);
        }
      `)
      .replace('#include <roughnessmap_fragment>', `
        #include <roughnessmap_fragment>
        {
          vec3 p = vDetailPos * uDetailScale;
          vec3 w = triWeights(normalize(vDetailNrm));
          vec3 orm = triSample(uDetailORM, p, w).rgb;
          roughnessFactor = clamp(mix(roughnessFactor, orm.g, uDetailRough), 0.04, 1.0);
        }
      `)
      .replace('#include <map_fragment>', `
        #include <map_fragment>
        #ifdef USE_CAMO
        {
          // Camo is projected triplanar like the rest of the surfacing, so it
          // needs no UVs and cannot seam. Multiplied against the base colour
          // rather than replacing it, so each part keeps its own value — the
          // canopy stays dark, the nozzle stays black — while the pattern reads
          // continuously across the whole airframe.
          vec3 cp = vDetailPos * uCamoScale;
          vec3 cw = triWeights(normalize(vDetailNrm));
          vec3 camo = triSample(uCamo, cp, cw).rgb;
          float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          // Only paint the mid-tone body. Very dark parts (canopy glass, the
          // exhaust void) and near-white ones are deliberate and must survive.
          float paint = smoothstep(0.04, 0.14, lum) * (1.0 - smoothstep(0.62, 0.85, lum));
          diffuseColor.rgb = mix(diffuseColor.rgb, camo * 1.35, paint * 0.88);

          // ---- Insignia, placed in OBJECT space ---------------------------
          // Triplanar tiles, so it can carry a pattern but never a decal in one
          // spot. Markings are therefore keyed off the model's own coordinates,
          // and gated on surface orientation so a wing roundel only appears on
          // surfaces actually facing up or down.
          vec2 em = vec2(mod(uEmblem, 2.0), floor(uEmblem / 2.0)) * 0.5;
          vec3 n = normalize(vDetailNrm);

          // Wing roundels: both wings, upper and lower surfaces.
          float up = abs(n.y);
          if (up > 0.55) {
            vec2 wl = (vDetailPos.xz - vec2(-2.45, -0.55)) / 1.5 + 0.5;
            vec2 wr = (vDetailPos.xz - vec2( 2.45, -0.55)) / 1.5 + 0.5;
            vec2 uvw = wl;
            if (all(greaterThan(wr, vec2(0.0))) && all(lessThan(wr, vec2(1.0)))) uvw = wr;
            if (all(greaterThan(uvw, vec2(0.0))) && all(lessThan(uvw, vec2(1.0)))) {
              vec4 mk = texture2D(uMarks, em + uvw * 0.5);
              diffuseColor.rgb = mix(diffuseColor.rgb, mk.rgb, mk.a * 0.92 * up);
            }
          }
          // Tail flash: on the fins, which are near-vertical lateral surfaces.
          float side = abs(n.x);
          if (side > 0.5 && vDetailPos.z < -1.6 && vDetailPos.y > 0.35) {
            vec2 uvt = (vDetailPos.zy - vec2(-3.15, 0.75)) / 1.15 + 0.5;
            if (all(greaterThan(uvt, vec2(0.0))) && all(lessThan(uvt, vec2(1.0)))) {
              vec4 mk = texture2D(uMarks, vec2(0.5, 0.5) + uvt * 0.5);   // chevrons
              diffuseColor.rgb = mix(diffuseColor.rgb, mk.rgb, mk.a * 0.85 * side);
            }
          }
        }
        #endif
      `)
      .replace('#include <metalnessmap_fragment>', `
        #include <metalnessmap_fragment>
        {
          vec3 p = vDetailPos * uDetailScale;
          vec3 w = triWeights(normalize(vDetailNrm));
          vec3 orm = triSample(uDetailORM, p, w).rgb;
          metalnessFactor = clamp(metalnessFactor + orm.b * uDetailMetal, 0.0, 1.0);
          // Occlusion darkens the recesses the panel pass carved.
          diffuseColor.rgb *= mix(1.0, orm.r, uDetailAO);
        }
      `);
  };
  material.needsUpdate = true;
  return material;
}

/** Apply surfacing to every material in a subtree. */
export function surfaceAll(root, opts) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      // Skip the exhaust cavity. Panel plating, paint-wear metalness and an
      // environment reflection would all lighten the one surface whose whole
      // job is to read as an absence of surface.
      if (m.name && /void/i.test(m.name)) continue;
      applyDetailSurfacing(m, opts);
    }
  });
  return root;
}
