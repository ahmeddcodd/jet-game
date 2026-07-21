// main.js — SKYBREAKER: boots Three.js, runs the game state machine & loop
import * as THREE from 'three';
import { createWorld } from './world.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { AudioEngine } from './audio.js';
import { ParticleField } from './particles.js';
import { EnemyJet, EnemyHelo, Bullet, Missile, Flare, MISSILE } from './enemies.js';
import { TargetingComputer, LOCK_STATE } from './targeting.js';
import { loadAll, loadStatus } from './assets.js';
import { clamp, rand, randInt, tmp } from './utils.js';

// ---------- Bootstrap ----------
const app = document.getElementById('app');
const loading = document.getElementById('loading');
const menu = document.getElementById('menu');
const pauseEl = document.getElementById('pause');
const gameoverEl = document.getElementById('gameover');
const hudEl = document.getElementById('hud');
const damageFlash = makeDamageFlash();

// logarithmicDepthBuffer: this scene spans from a jet a few units away to a
// 6000-unit sky dome. With a conventional depth buffer that range leaves almost
// no precision at distance, which shows up on real GPUs as z-fighting — large
// hard-edged patches flickering black — while software renderers often hide it.
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// near=0.5 gave a 16000:1 depth range for no benefit — the camera never gets
// closer than ~12 units to anything. 2.0 reclaims two orders of magnitude of
// precision while staying far inside the chase distance.
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 2.0, 8000);
camera.position.set(0, 130, -20);

// Lighting
// Three-light rig. The hemisphere ground colour used to be a near-black blue,
// and there was no ambient at all — so any aircraft face angled away from the
// sun fell to luminance ~20/255 and a flat-shaded delta wing read as a solid
// black quad. The ambient term exists purely so unlit faces stay dark *metal*
// rather than crushing to black.
const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6b7f96, 1.15);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0x9fb8d4, 0.85);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xfff2d0, 2.1);
sun.position.set(-800, 1400, -1200);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 100;
sun.shadow.camera.far = 4000;
const sc = sun.shadow.camera;
sc.left = -700; sc.right = 700; sc.top = 700; sc.bottom = -700;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

// Sunlight follows player so the shadow frustum always covers the action.
const shadowOffset = new THREE.Vector3(-800, 1400, -1200);
sun.position.copy(shadowOffset);

// World + systems — created AFTER assets are loaded (see init() at bottom).
let world, particles, player;
const input = new Input(renderer.domElement);
const audio = new AudioEngine();
const hud = new HUD();
const targeting = new TargetingComputer();
let assetsReady = false;

// ---------- Game state ----------
const game = {
  state: 'menu',       // menu | playing | paused | gameover
  score: 0,
  kills: 0,
  wave: 0,
  enemies: [],
  bullets: [],
  missiles: [],
  flares: [],
  waveActive: false,
  waveTimer: 0,
  streak: 0,
  bestStreak: 0,
  lastKillTime: -99,
  spawnQueue: [],
  spawnTimer: 0,
  time: 0,
};

// ---------- Wave system ----------
function startNextWave() {
  game.wave++;
  game.waveActive = true;
  const w = game.wave;
  // Compose spawn list for this wave
  // Gentler early ramp so the first few waves teach the fight, then a steady
  // climb. The old curve jumped to 4 jets by wave 3 and capped out by wave 10,
  // which made early waves overwhelming and late ones identical.
  const jets = Math.min(1 + Math.round(Math.pow(w, 0.85) * 0.85), 12);
  const helos = Math.min(Math.floor(w * 0.45), 7);
  game.spawnQueue = [];
  for (let i = 0; i < jets; i++) game.spawnQueue.push('jet');
  for (let i = 0; i < helos; i++) game.spawnQueue.push('helo');
  // Shuffle
  for (let i = game.spawnQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [game.spawnQueue[i], game.spawnQueue[j]] = [game.spawnQueue[j], game.spawnQueue[i]];
  }
  game.spawnTimer = 0.8;
  hud.message(`WAVE ${w}`, `${jets} jets · ${helos} helos inbound`, 2.6);
  audio.waveStart();
}

function spawnEnemy(type) {
  let e;
  if (type === 'jet') e = new EnemyJet(player.position);
  else e = new EnemyHelo(player.position);
  e.onShoot = enemyShoot;
  e.onMissile = enemyFireMissile;
  e.onFlare = enemyDeployFlares;
  scene.add(e.mesh);
  game.enemies.push(e);
}

function checkWaveComplete() {
  if (game.waveActive && game.spawnQueue.length === 0 && game.enemies.length === 0) {
    game.waveActive = false;
    game.waveTimer = 4.0;
    hud.message('SECTOR CLEAR', `Wave ${game.wave} complete`, 2.6);
    // Reward: +1 missile each wave (max 8)
    player.missiles = Math.min(player.maxMissiles + Math.min(game.wave, 4), player.missiles + 1);
    game.score += 250 * game.wave;
  }
}

/**
 * F9 — render-artifact probe.
 *
 * Renders the current frame off-screen, finds the largest contiguous dark
 * region, and raycasts through it to name whatever is actually there. Exists
 * because a black patch reported from a real GPU could not be reproduced under
 * software rendering; this reports the culprit from the machine that sees it.
 */
function probeDarkRegion() {
  const W = 200, H = 130;
  const rt = new THREE.WebGLRenderTarget(W, H);
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  renderer.setRenderTarget(null);
  rt.dispose();

  const dark = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < buf.length; i += 4, p++) {
    const l = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    if (l < 55) dark[p] = 1;
  }
  const seen = new Uint8Array(W * H);
  let best = [];
  for (let p0 = 0; p0 < W * H; p0++) {
    if (!dark[p0] || seen[p0]) continue;
    const stack = [p0]; seen[p0] = 1; const cells = [];
    while (stack.length) {
      const p = stack.pop(); cells.push(p);
      const x = p % W, y = (p / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const np = ny * W + nx;
        if (dark[np] && !seen[np]) { seen[np] = 1; stack.push(np); }
      }
    }
    if (cells.length > best.length) best = cells;
  }

  const pct = (100 * best.length / (W * H)).toFixed(1);
  if (best.length < 40) {
    console.log(`[probe] no significant dark region (largest ${best.length}px, ${pct}%)`);
    return;
  }
  const rc = new THREE.Raycaster();
  rc.far = 20000;
  const tally = new Map();
  for (let k = 0; k < best.length; k += Math.max(1, Math.floor(best.length / 50))) {
    const p = best[k];
    rc.setFromCamera({ x: ((p % W) / W) * 2 - 1, y: (((p / W) | 0) / H) * 2 - 1 }, camera);
    const hit = rc.intersectObjects(scene.children, true)[0];
    const key = hit
      ? `${hit.object.name || '(unnamed)'} < ${hit.object.parent?.name || '?'} [${hit.object.material?.type}] d=${Math.round(hit.distance)}`
      : '(nothing — sky/background)';
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  console.log(`[probe] dark region ${best.length}px (${pct}% of frame). Hits:`);
  for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`   ${v}x  ${k}`);
  console.log('[probe] camera', camera.position.toArray().map((n) => Math.round(n)),
    'jet alt', Math.round(player.position.y), 'spd', Math.round(player.speed));
}

// ---------- Chase / targeting overlay ----------
const PLAYER_BULLET_SPEED = 420;
const _tv1 = new THREE.Vector3();
const _tv2 = new THREE.Vector3();
const _tv3 = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _tactical = [];

/**
 * Builds the per-frame chase overlay: which bandit is the primary target,
 * where to put the pipper to hit it, and whether anything is on our six.
 *
 * Projection happens here rather than in hud.js because this is where the
 * camera lives; the HUD just draws what it is handed.
 */
function updateTactical(dt) {
  const w = window.innerWidth, h = window.innerHeight;
  _tactical.length = 0;
  _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);

  const playerFwd = player.forward;
  let locked = null, lockedDot = 0.86, lockedDist = 0;

  // Primary target = the bandit closest to the nose, within lock range.
  for (const e of game.enemies) {
    if (!e.alive) continue;
    const to = _tv1.copy(e.position).sub(player.position);
    const d = to.length();
    if (d > 1600) continue;
    const dot = playerFwd.dot(to.divideScalar(d));
    if (dot > lockedDot) { lockedDot = dot; locked = e; lockedDist = d; }
  }

  let threatActive = false, threatDist = 0;

  for (const e of game.enemies) {
    if (!e.alive) continue;
    const dist = e.position.distanceTo(player.position);
    if (dist > 2200) continue;

    // Behind-camera check must come from the camera vector, not the projected
    // z — points behind the near plane project to mirrored coordinates.
    const behind = _tv1.copy(e.position).sub(camera.position).dot(_camFwd) < 0;
    _tv2.copy(e.position).project(camera);
    const sx = (_tv2.x * 0.5 + 0.5) * w;
    const sy = (-_tv2.y * 0.5 + 0.5) * h;
    const onScreen = !behind && Math.abs(_tv2.x) <= 1 && Math.abs(_tv2.y) <= 1;

    let lead = null;
    if (e === locked) {
      // First-order intercept: where it will be when the burst arrives.
      const tof = Math.min(dist / PLAYER_BULLET_SPEED, 2.0);
      _tv3.copy(e.position).addScaledVector(e.velocity, tof).project(camera);
      lead = { x: (_tv3.x * 0.5 + 0.5) * w, y: (-_tv3.y * 0.5 + 0.5) * h };
    }

    // Rear threat: this bandit is behind us and pointing at us.
    if (!threatActive && e.type === 'jet' &&
        player.isTailedBy && player.isTailedBy(e)) {
      threatActive = true;
      threatDist = dist;
    }

    _tactical.push({
      pos: e.position, type: e.type, hp01: Math.max(0, e.hp / e.maxHp),
      locked: e === locked, lead, dist, onScreen, sx, sy, behind,
    });
  }

  hud.drawTactical(_tactical, { active: threatActive });
  hud.setThreat(threatActive, threatDist);

  // Lock reticle rides on top of the target boxes.
  const lockTgt = targeting.target;
  if (lockTgt) {
    const entry = _tactical.find((t) => t.pos === lockTgt.position);
    if (entry) {
      hud.drawLock(targeting.state, targeting.progress, entry.sx, entry.sy, entry.onScreen);
    }
  }
  hud.setLockState(targeting.state, targeting.progress);
  hud.setMissileWarning(!!incomingMissile());
  hud.setFlares(player.flares, player.maxFlares);
  hud.setG(player.gLoad);

  // Closure on the locked target, measured from distance delta.
  if (locked) {
    const prev = locked._prevLockDist;
    const closure = (prev !== undefined && dt > 0) ? (prev - lockedDist) / dt : 0;
    locked._prevLockDist = lockedDist;
    hud.setClosure(closure, true);
  } else {
    hud.setClosure(0, false);
  }
}

// ---------- Weapons ----------
function firePlayerGun() {
  // Two barrels, slight spread
  const fwd = player.forward;
  const origin = player.position.clone().addScaledVector(fwd, 3);
  for (const off of [0.75, -0.75]) {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(player.mesh.quaternion);
    const o = origin.clone().addScaledVector(right, off);
    const dir = fwd.clone();
    dir.x += rand(-0.01, 0.01); dir.y += rand(-0.01, 0.01); dir.z += rand(-0.01, 0.01);
    const b = new Bullet(scene, o, dir, 420, 'player', 8, 0xfff2a0);
    game.bullets.push(b);
  }
  audio.gun();
}

function firePlayerMissile() {
  // Fires on the radar lock. Without one it launches ballistic — you can
  // still snap-shoot, but you give up the guidance that makes it worth a round.
  const target = targeting.lockedTarget;
  const fwd = player.forward;
  const origin = player.position.clone().addScaledVector(fwd, 2.5);
  origin.y -= 0.4;
  const m = new Missile(scene, origin, target, 'player');
  m.dir.copy(fwd);
  // Inherit launch-aircraft speed so it doesn't start from a standstill.
  m.speed = Math.max(m.speed, player.speed + 40);
  game.missiles.push(m);
  hud.message(target ? 'FOX 2' : 'FOX 2 — NO LOCK', '', 1.1);
  audio.missile();
}

/** Enemy missile shot at the player. */
function enemyFireMissile(enemy) {
  const fwd = enemy.forward(tmp.v1).clone();
  const origin = enemy.position.clone().addScaledVector(fwd, 3);
  const m = new Missile(scene, origin, player, 'enemy');
  m.dir.copy(fwd);
  m.speed = Math.max(m.speed, enemy.speed + 40);
  m.damage = 38;
  game.missiles.push(m);
  audio.missile();
}

function enemyDeployFlares(enemy) {
  const back = enemy.forward(tmp.v1).clone().multiplyScalar(-1);
  for (let i = 0; i < 3; i++) {
    const v = back.clone().multiplyScalar(enemy.speed * 0.35);
    v.x += rand(-20, 20); v.y += rand(-6, 12); v.z += rand(-20, 20);
    game.flares.push(new Flare(scene, enemy.position.clone(), v, 'enemy'));
  }
}

function deployFlares() {
  if (player.flares <= 0 || player.flareCooldown > 0) return;
  player.flares--;
  player.flareCooldown = 0.8;
  const back = player.forward.multiplyScalar(-1);
  for (let i = 0; i < 4; i++) {
    const v = back.clone().multiplyScalar(player.speed * 0.35);
    v.x += rand(-24, 24); v.y += rand(-6, 14); v.z += rand(-24, 24);
    const o = player.position.clone().addScaledVector(back, 3);
    game.flares.push(new Flare(scene, o, v, 'player'));
  }
  audio.gun();
}

/** True if any live enemy missile is tracking the player. */
function incomingMissile() {
  for (const m of game.missiles) {
    if (m.owner === 'enemy' && m.alive && m.hasLock && m.target === player) return m;
  }
  return null;
}

/** Is a player missile guiding on this enemy, and close enough to matter? */
function missileTracking(enemy) {
  for (const m of game.missiles) {
    if (m.owner !== 'player' || !m.alive || !m.hasLock || m.target !== enemy) continue;
    if (m.position.distanceTo(enemy.position) < 500) return true;
  }
  return false;
}

function enemyShoot(enemy, targetPlayer) {
  const origin = enemy.position.clone();
  const dir = tmp.v1.copy(targetPlayer.position).sub(origin).normalize();
  // lead the target a little
  const lead = dir.clone().multiplyScalar(rand(0.0, 0.08));
  dir.add(lead).normalize();
  origin.addScaledVector(dir, 2);
  const b = new Bullet(scene, origin, dir, 260, 'enemy', enemy.type === 'helo' ? 6 : 9, 0xff6644);
  game.bullets.push(b);
}

// ---------- Update systems ----------
function updateEnemies(dt) {
  for (let i = game.enemies.length - 1; i >= 0; i--) {
    const e = game.enemies[i];
    e.update(dt, game.time, player);
    // Defend against anything guiding on us — the same counter the player has.
    e.tryFlares(dt, missileTracking(e));
    // Despawn if too far away / out of bounds
    if (e.position.distanceTo(player.position) > 3500) {
      scene.remove(e.mesh);
      e.mesh.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
      game.enemies.splice(i, 1);
      continue;
    }
    // Damage smoke when low HP
    if (e.hp / e.maxHp < 0.4 && Math.random() < 0.4) {
      particles.smokePuff(e.position.clone().addScaledVector(tmp.v2.set(0, 0.2, -2).applyQuaternion(e.mesh.quaternion), 1), 0x444444);
    }
    if (!e.alive) {
      onEnemyKilled(e);
      scene.remove(e.mesh);
      e.mesh.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
      game.enemies.splice(i, 1);
    }
  }
}

// Kills inside this window chain into a streak. Short enough that it rewards
// actually working a group rather than just surviving long enough.
const STREAK_WINDOW = 6.0;
const STREAK_NAMES = ['', '', 'DOUBLE', 'TRIPLE', 'RAMPAGE', 'ONSLAUGHT', 'ANNIHILATION'];

function onEnemyKilled(e) {
  game.kills++;

  // Streak multiplier: each chained kill is worth progressively more, capped
  // so a good run is rewarded without making the score meaningless.
  if (game.time - game.lastKillTime <= STREAK_WINDOW) game.streak++;
  else game.streak = 1;
  game.lastKillTime = game.time;
  game.bestStreak = Math.max(game.bestStreak, game.streak);

  const mult = Math.min(1 + (game.streak - 1) * 0.35, 3.0);
  const points = Math.round(e.score * mult);
  game.score += points;

  particles.explosion(e.position.clone(), e.type === 'helo' ? 1.4 : 1.1);
  audio.explosion();
  hud.hitMarker();
  player.addTrauma(0.12);

  if (game.streak >= 2) {
    const name = STREAK_NAMES[Math.min(game.streak, STREAK_NAMES.length - 1)];
    hud.message(name, `${game.streak} KILLS  ·  x${mult.toFixed(2)}  ·  +${points}`, 1.5);
  }
  hud.floatScore(`+${points}`, game.streak >= 2);

  // Chain: missiles targeting this enemy lose lock (they'll fly straight)
  for (const m of game.missiles) if (m.target === e) m.target = null;
  // Dropping the dead bandit frees the seeker to grab the next threat.
  if (targeting.target === e) targeting.clear(true);
}

function updateBullets(dt) {
  for (let i = game.bullets.length - 1; i >= 0; i--) {
    const b = game.bullets[i];
    b.update(dt);
    let consumed = false;

    if (b.owner === 'player') {
      // check enemy hits
      for (const e of game.enemies) {
        if (!e.alive) continue;
        const r = e.type === 'helo' ? 3.2 : 2.6;
        if (b.position.distanceTo(e.position) < r) {
          const killed = e.damage(b.damage);
          particles.hitSpark(b.position.clone(), b.dir.clone());
          if (killed) { /* handled in updateEnemies */ }
          audio.hit();
          consumed = true;
          break;
        }
      }
    } else if (b.owner === 'enemy') {
      // check player hit
      if (b.position.distanceTo(player.position) < 2.4) {
        if (player.damage(b.damage)) {
          audio.playerHit();
          flashDamage();
        }
        consumed = true;
      }
    }

    if (consumed || !b.alive) {
      b.destroy(scene);
      game.bullets.splice(i, 1);
    }
  }
}

/**
 * Tear down every live entity, releasing GPU resources.
 * Truncating the arrays alone would orphan each entity's mesh, geometry and
 * material in the scene — a leak that compounds with every restart.
 */
function clearEntities() {
  for (const e of game.enemies) scene.remove(e.mesh);
  for (const b of game.bullets) b.destroy(scene);
  for (const m of game.missiles) m.destroy();
  for (const f of game.flares) f.destroy();
  game.enemies.length = 0;
  game.bullets.length = 0;
  game.missiles.length = 0;
  game.flares.length = 0;
  targeting.clear(true);
}

function updateFlares(dt) {
  for (let i = game.flares.length - 1; i >= 0; i--) {
    const f = game.flares[i];
    f.update(dt);
    if (Math.random() < 0.6) {
      particles.smokePuff(f.position.clone(), 0xffcc88);
    }
    if (!f.alive) { f.destroy(); game.flares.splice(i, 1); }
  }
}

function updateMissiles(dt) {
  for (let i = game.missiles.length - 1; i >= 0; i--) {
    const m = game.missiles[i];
    // Offer decoys to the seeker before guiding, so a flare popped this frame
    // can still spoof a missile already in the terminal phase.
    if (game.flares.length) m.considerFlares(game.flares);
    m.update(dt);

    // smoke trail
    if (Math.random() < 0.7) {
      particles.smokePuff(m.position.clone().addScaledVector(m.dir, -0.8), 0xddaa66);
    }

    let consumed = !m.alive;

    // Proximity fuze: the missile flags itself, we resolve the blast here so
    // splash can catch a target the warhead didn't directly contact.
    if (m.detonated) {
      particles.explosion(m.position.clone(), 1.2);
      audio.explosion();
      player.addTrauma(0.25);
      const victims = m.owner === 'player' ? game.enemies : [player];
      for (const v of victims) {
        if (!v.alive) continue;
        const d = m.position.distanceTo(v.position);
        if (d > MISSILE.proximity * 1.6) continue;
        // Falls off with distance — a near miss wounds, a direct hit kills.
        const falloff = 1 - (d / (MISSILE.proximity * 1.6)) * 0.6;
        const killed = v.damage(Math.round(m.damage * falloff));
        if (v === player) { if (killed) flashDamage(); }
        else if (!killed) audio.hit();
      }
      consumed = true;
    } else if (m.alive) {
      // Direct contact still counts for anything the fuze didn't catch.
      const victims = m.owner === 'player' ? game.enemies : [player];
      for (const v of victims) {
        if (!v.alive) continue;
        const r = v === player ? 4.0 : (v.type === 'helo' ? 4.0 : 3.4);
        if (m.position.distanceTo(v.position) < r) {
          const killed = v.damage(m.damage);
          particles.explosion(m.position.clone(), 1.0);
          if (v === player) flashDamage();
          else if (!killed) audio.hit();
          consumed = true;
          break;
        }
      }
    }

    if (consumed) {
      m.destroy();
      game.missiles.splice(i, 1);
    }
  }
}

// ---------- Damage feedback ----------
function makeDamageFlash() {
  const el = document.createElement('div');
  el.id = 'damage-flash';
  document.body.appendChild(el);
  return el;
}
let flashTimer = 0;
function flashDamage() {
  damageFlash.style.opacity = '1';
  flashTimer = 0.4;
}

// ---------- Game loop ----------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp big frame gaps
  game.time += dt;

  input.update(dt);

  // Render the world even on the menu so the scene is alive in the background,
  // but only run gameplay when assets are loaded and we're playing.
  stepGame(dt);

  if (world) world.update(game.time, dt);

  // Keep sunlight + shadow frustum centered on the action
  if (player) {
    sun.target.position.lerp(player.position, 0.1);
    sun.position.copy(player.position).add(shadowOffset);
  }

  renderer.render(scene, camera);
}

/** One tick of gameplay. Split out of animate() so it can be stepped
 *  independently of requestAnimationFrame when profiling or debugging. */
function stepGame(dt) {
  if (game.state === 'playing' && assetsReady && player) {
    player.update(dt, game.time);

    // ---- Targeting: manual overrides first, then the seeker tick ----
    if (input.pressed.has('Tab')) targeting.cycle(player, game.enemies);
    if (input.pressed.has('KeyR')) targeting.lockNearest(player, game.enemies);
    if (input.pressed.has('KeyT')) targeting.clear();
    if (input.pressed.has('F9')) probeDarkRegion();
    targeting.update(dt, player, game.enemies);

    updateEnemies(dt);
    updateBullets(dt);
    updateMissiles(dt);
    updateFlares(dt);
    particles.update(dt);

    // Spawning
    if (game.waveActive && game.spawnQueue.length > 0) {
      game.spawnTimer -= dt;
      if (game.spawnTimer <= 0) {
        spawnEnemy(game.spawnQueue.shift());
        game.spawnTimer = rand(0.8, 2.0);
      }
    }
    checkWaveComplete();
    if (!game.waveActive) {
      game.waveTimer -= dt;
      if (game.waveTimer <= 0) startNextWave();
    }

    // Player death
    if (!player.alive) {
      particles.explosion(player.position.clone(), 2.0);
      audio.explosion();
      audio.gameOver();
      endGame();
    }

    // Audio engine update
    audio.updateEngine(player.throttle, player.boostActive);

    // HUD refresh
    hud.setScore(game.score);
    hud.setWave(game.wave);
    hud.setKills(game.kills);
    hud.setVitals(player.health, player.maxHealth, player.throttle, player.boost);
    hud.setCritical(player.health <= player.maxHealth * 0.28);
    // Streak lapses on its own, so the HUD reflects it without waiting for a kill.
    if (game.streak && game.time - game.lastKillTime > STREAK_WINDOW) game.streak = 0;
    hud.setMissiles(player.missiles);
    const fwdFlat = tmp.v1.set(0, 0, 1).applyQuaternion(player.mesh.quaternion);
    hud.drawRadar(player.position, fwdFlat, game.enemies.map(e => ({ x: e.position.x, z: e.position.z, type: e.type })));
    updateTactical(dt);
    hud.update(dt);

    // damage flash decay
    if (flashTimer > 0) {
      flashTimer -= dt;
      damageFlash.style.opacity = `${Math.max(0, flashTimer / 0.4)}`;
    }
  }
}

// ---------- Game state transitions ----------
function startGame() {
  if (!assetsReady) return; // ignore clicks before assets are loaded
  audio.init();
  audio.resume();
  audio.startEngine();

  game.state = 'playing';
  game.score = 0;
  game.kills = 0;
  game.wave = 0;
  clearEntities();
  game.spawnQueue.length = 0;
  game.waveActive = false;
  game.waveTimer = 1.5;

  player.reset();
  menu.classList.add('hidden');
  gameoverEl.classList.add('hidden');
  pauseEl.classList.add('hidden');
  hud.show();
  hud.message('ENGAGE', 'Protect the skies', 2.2);
  input.requestPointerLock();
}

function pauseGame() {
  if (game.state !== 'playing') return;
  game.state = 'paused';
  pauseEl.classList.remove('hidden');
  input.exitPointerLock();
}
function resumeGame() {
  if (game.state !== 'paused') return;
  game.state = 'playing';
  pauseEl.classList.add('hidden');
  input.requestPointerLock();
}

function endGame() {
  game.state = 'gameover';
  audio.stopEngine();
  document.getElementById('final-score').textContent = game.score.toLocaleString();
  document.getElementById('final-wave').textContent = game.wave;
  document.getElementById('final-kills').textContent = game.kills;
  setTimeout(() => {
    gameoverEl.classList.remove('hidden');
    hud.hide();
    input.exitPointerLock();
  }, 1200);
}

// ---------- UI wiring ----------
document.getElementById('start-btn').addEventListener('click', () => { audio.uiConfirm(); startGame(); });
document.getElementById('restart-btn').addEventListener('click', () => { audio.uiConfirm(); startGame(); });
document.getElementById('resume-btn').addEventListener('click', () => { audio.uiConfirm(); resumeGame(); });
document.getElementById('quit-btn').addEventListener('click', () => {
  audio.uiConfirm();
  game.state = 'menu';
  pauseEl.classList.add('hidden');
  menu.classList.remove('hidden');
  hud.hide();
  audio.stopEngine();
  // soft reset player for next deploy
  player.reset();
});

// Pause on pointer lock loss (e.g. user pressed Esc)
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && game.state === 'playing') {
    pauseGame();
  }
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyP') {
    if (game.state === 'playing') pauseGame();
    else if (game.state === 'paused') resumeGame();
  }
});

// Hover sounds on buttons
document.querySelectorAll('button').forEach((b) => {
  b.addEventListener('mouseenter', () => audio.enabled && audio.uiHover());
});

// ---------- Resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  hud.resizeTactical(window.innerWidth, window.innerHeight);
});
hud.resizeTactical(window.innerWidth, window.innerHeight);

// ---------- Kickoff ----------
// Show the loading screen until all Blender-exported glb assets are fetched,
// then build the world + player (which depend on those assets) and start.
(async function init() {
  // Start the render loop early so the scene background paints while loading.
  animate();
  const loadStart = performance.now();
  // Surface a helpful message if assets take unusually long (e.g. server down).
  const slowTimer = setTimeout(() => {
    if (!assetsReady) {
      document.querySelector('#loading p').innerHTML =
        'Still loading… if this hangs, check the server is running ' +
        '(<b>npm run dev</b>) and view the console (F12).';
    }
  }, 8000);
  try {
    await loadAll();
  } catch (e) {
    clearTimeout(slowTimer);
    console.error('Asset loading failed:', e);
    document.querySelector('#loading p').innerHTML =
      'Failed to load 3D assets.<br>' +
      'Make sure the server is running (<b>npm run dev</b>) and you opened ' +
      '<b>http://localhost:8080</b> (not the file:// path).<br>' +
      '<small style="color:#9bb">' + (e && e.message ? e.message : e) + '</small>';
    return;
  }
  clearTimeout(slowTimer);
  // Now that assets are cached, build the world + player.
  try {
    world = createWorld(scene);
    particles = new ParticleField(scene, 1200);
    player = new Player(camera, input);
    // Wire player weapon hooks (must happen after the Player exists).
    player.onFireGun = firePlayerGun;
    player.onFireMissile = firePlayerMissile;
    player.onFlares = deployFlares;
    player.onManeuver = (name, failed) => hud.message(name, '', failed ? 1.0 : 0.9);
    scene.add(player.mesh);
    assetsReady = true;
    loading.style.display = 'none';
    // Dev-only handle for profiling from the console (renderer.info.render
    // gives live draw-call / triangle counts). Stripped from production builds.
    if (import.meta.env.DEV) {
      window.__sky = {
        THREE, renderer, scene, camera, game, world, player, targeting, hud,
        step: (dt = 1 / 60, n = 1) => { for (let i = 0; i < n; i++) { game.time += dt; stepGame(dt); } },
        // Off-screen frame grab. Renders through a render target so a frame can
        // be inspected without depending on the canvas drawing buffer being
        // preserved. Returns a JPEG data URL.
        capture: (w = 420, h = 260, quality = 0.72) => {
          const rt = new THREE.WebGLRenderTarget(w, h);
          rt.texture.colorSpace = THREE.SRGBColorSpace;  // match on-screen output
          const prevRT = renderer.getRenderTarget();
          renderer.setRenderTarget(rt);
          renderer.render(scene, camera);
          const buf = new Uint8Array(w * h * 4);
          renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
          renderer.setRenderTarget(prevRT);
          rt.dispose();
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          const img = ctx.createImageData(w, h);
          // readRenderTargetPixels is bottom-up; flip into image order.
          for (let y = 0; y < h; y++) {
            const src = (h - 1 - y) * w * 4;
            img.data.set(buf.subarray(src, src + w * 4), y * w * 4);
          }
          ctx.putImageData(img, 0, 0);
          return c.toDataURL('image/jpeg', quality);
        },
      };
    }
  } catch (e) {
    console.error('World/player init failed:', e);
    document.querySelector('#loading p').innerHTML =
      'Init error:<br><small style="color:#f88">' + (e && e.stack ? e.stack : e) + '</small>';
  }
})();

