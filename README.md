# SKYBREAKER — Low Poly Jet Combat

A browser-based, flat-shaded low-poly fighter jet shooter built with **Three.js**. Pilot a supermaneuverable jet through an archipelago and shoot down waves of incoming helicopters and enemy jets.

> **All 3D assets are authored in Blender** (real `.blend` source files in `blender/`), exported to `.glb`, and loaded at runtime by Three.js `GLTFLoader`. The player jet, enemy jets, helicopters, missiles, trees, rocks, and clouds are each a Blender model built from flat-shaded low-poly primitives and named parts (rotors, afterburners, nav lights) that the game discovers and animates. Terrain, ocean, and sky are generated procedurally in Three.js (heightfield mesh, animated water plane, GLSL sky shader). No external textures.


---

## ▶ How to run

A Vite + Three.js project. Requires Node 20+.

```bash
cd jet-game
npm install
npm run dev          # http://localhost:5173 (opens automatically)
```

Then click **DEPLOY** to lock your mouse and fly.

**Other scripts:**
```bash
npm run build        # production bundle → dist/
npm run preview      # serve the built dist/ locally
```

---

## ▲ Deploying to Vercel

The repo is deploy-ready — import it at [vercel.com/new](https://vercel.com/new) and accept the detected settings. `vercel.json` pins them explicitly anyway:

| Setting | Value |
|---|---|
| Framework | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node | `>=20.19` (via `engines`) |

Or from the CLI:

```bash
npx vercel        # preview deployment
npx vercel --prod # production
```

Notes on the config:

- **Caching.** `dist/assets/*.js|css` are content-hashed by Vite, so Vercel's Vite preset already serves them immutable. The `.glb` models and Draco decoder are *not* hashed — they ship verbatim from `public/` — so `vercel.json` gives those a 1-day cache with `stale-while-revalidate` instead. The header rules deliberately don't overlap Vite's hashed output, so there's no rule-ordering ambiguity.
- **No rewrites.** This is a single static page with no client-side routing. A catch-all rewrite would turn a missing `.glb` into a 200 serving `index.html`, silently masking a broken asset — so there isn't one.
- **`.vercelignore`** keeps `blender/` (~5 MB of `.blend` sources) out of deploy uploads. Only the exported `.glb` files in `public/` are needed to build.
- **Relative base.** `vite.config.js` sets `base: './'`, so the build also works when served from a subpath, not just a domain root.

> Requires a modern browser with WebGL2 (Chrome, Edge, Firefox, Safari 16+). Best with a mouse + keyboard.

---

## 🎮 Controls

| Input | Action |
|---|---|
| **Mouse** | Steer — X banks and turns, Y pulls |
| **Arrows** | Steer (full keyboard parity with the mouse) |
| **A / D** | Free roll (bypasses the bank hold — for aerobatics) |
| **Q / E** | Rudder |
| **W / S** | Throttle up / down |
| **Shift** | Afterburner |
| **Left Click** | Fire twin cannons (infinite ammo) |
| **Right Click** / **F** | Launch missile (guided if you have a lock, ballistic if not) |
| **R** | Lock nearest target to the nose |
| **Tab** | Cycle targets · **T** drop lock |
| **Space** | Deploy flares |
| **C** | Toggle cockpit / chase view |
| **P** / **Esc** | Pause |

### How the mouse works

Mouse motion drives a **virtual self-centring stick**, drawn as a small box below the crosshair — pointer lock hides the cursor, so that indicator is the only way to see what you are currently commanding. Horizontal position commands a **bank angle the jet holds**, and the coordinated-turn assist pulls the nose around, so banking alone steers. Release and the stick returns to neutral, and the jet rolls wings-level in about 2¼ seconds from a hard bank.

Two properties make it predictable:

- **Everything is per second, never per frame**, so the controls feel identical at 30, 60, 144 or 240 fps.
- **The return-to-centre scales with deflection** (`returnBase + returnProp × deflection` in [`input.js`](src/input.js)). A single flat rate would either cancel any drag slower than itself — killing fine aiming — or crawl back from a hard turn. There is no deadband, so small corrections register.

Response is graded and stable across the range: a 2px/frame drag settles at 9° of bank, 4px at 31°, 8px at 70°, 20px at 78°.

### Dogfight maneuvers

| Key | Maneuver | What it does |
|---|---|---|
| **Z** | Split-S | Roll inverted and pull through — reverses heading ~173°, ends upright |
| **X** | Immelmann | Half loop then roll upright — reverses heading ~172°, costs ~37 speed. Refuses below 105 units/s |
| **B** | Barrel roll | Corkscrew that scrubs speed and displaces you — forces a closing attacker out in front |
| **V** | Break turn | Max-G defensive turn into the threat |

Every one of these is flyable by hand with roll and pitch; the keys just make them reliable to execute with a mouse. They run *through* the flight model, so they cost real energy.

---

## 🕹 Gameplay

- **Energy fighting.** Speed is an outcome of thrust, the gravity component along your flight path, and drag — not a number you set. Diving builds energy, climbing spends it, and hard turns bleed it. Turn rate peaks at a **corner speed of 115 units/s**; below that the wing can't pull limit G, above it you're structurally capped and the radius grows:

  | Speed | 50 | 80 | **115** | 150 | 200 |
  |---|---|---|---|---|---|
  | Turn rate °/s | 108 | 134 | **145** | 125 | 105 |

- **One flight model for both sides.** The player and the AI fly the *same* code ([`src/flight.js`](src/flight.js)) — the same lift-limited G, the same corner speed, the same coordinated turn, and speed as an outcome of thrust, gravity along the flight path and drag. Enemies used to slerp their nose onto a target vector at a fixed rate with their speed assigned directly, so they could turn as hard at 40 units/s as at 200 and never gained a knot in a dive. Now a bandit's bank never moves faster than the airframe's roll rate (measured: median 0.12°/frame, max 3.04° against a 3.25°/frame limit), so nothing it does is outside what your own jet could do.
- **Pursuit dogfighting, both ways.** Enemy jets run a full BFM state machine — **lag pursuit** to kill an overtake, **pure** to close, **lead** for a gun solution, **high yo-yo** when overshooting, **low yo-yo** to convert altitude into closure, and defensively **break**, **barrel roll** to force an overshoot, or **flat scissors** to drag you out in front. They pick the response that fits the geometry: a fast attacker close aboard gets a barrel roll, a slow grinding one gets scissored.
- **Radar lock and countermeasures.** A lock takes ~1.15 s of holding a bandit in the seeker cone, so breaking hard before the tone goes solid is a real counter. Both sides carry flares.
- **You can be hunted.** A bandit chasing you asks for *your* speed plus a closure term proportional to the range it still has to take out, so it accelerates to run you down and decelerates to settle on your six rather than overshooting. Measured from a cold start 900 units astern: it closes 900 → 650 → 433 → 228 and stabilises at 148, matching speed exactly. Ignoring one gets you killed; escaping is possible but costs you the burner you wanted for the chase.
- **Endless wave survival.** Each wave spawns a mix of **enemy jets** (fast interceptors) and **helicopters** (slow gunships that maintain range and strafe).
- **Scoring:** jets = 150 pts, helicopters = 200 pts, plus a wave-clear bonus of `250 × wave`.
- **Health (HULL):** you start at 100. Enemy bullets deal 6–9 dmg. Brief invulnerability after a hit prevents instant death.
- **Afterburner:** hold Shift for a speed surge + widened FOV — recharges when released.
- **Missiles use proportional navigation** — the real guidance law. The missile turns at 4× the rotation rate of the line of sight, so if that rate goes to zero it's on a collision course, and it flies a lead intercept automatically instead of chasing a tail. The counters fall out of the same maths rather than being special-cased: a finite turn rate means it can be out-turned up close, a finite seeker FOV means a big enough aspect change breaks lock and sends it ballistic, and flares present a competing source inside the seeker cone. Measured: it intercepts a hard-breaking target for full damage, and is defeated outright by flares plus a break. You earn +1 missile each wave clear (max 8).
- The world has soft boundaries — fly too far out and the jet banks you back toward the action.

---

## 🎨 Design notes — "Blender-style" low poly

**Models are authored in Blender** via `bpy` Python scripts (`blender/build_*.py`) that build each asset from flat-shaded primitives (`bpy.ops.mesh.primitive_*`), assign Principled BSDF materials with solid colors, and group parts under named Empties/objects so the game can find them at runtime (e.g. the helicopter's `Rotor` and `TailRotor` nodes, the player jet's `Flame`/`Glow`/`Nav` parts). Each script saves a `.blend` source file and exports a `.glb` into `public/assets/models/`. The game's `GLTFLoader` fetches these at startup (see the loading screen) and `src/models.js` hands out clones with runtime hooks wired by name.

- **Hard edges, no smoothing:** every polygon is flat-shaded (`use_smooth = False`), giving the faceted low-poly look.
- **Solid palette per object:** each aircraft uses a body / body2 / accent / dark material set, like assigning flat materials to faces in Blender.
- **Procedural terrain** (in Three.js): islands are `CircleGeometry` whose vertices are displaced by value-noise FBM, then painted with **per-vertex colors** by altitude (sand → grass → rock → snow). The heightfield, animated ocean, and GLSL gradient sky dome are generated in code — not Blender — because they're mathematical rather than authored shapes.
- **Animated ocean:** a 120×120 plane whose vertices ride layered sines, recomputed each frame.
- **Clouds:** Blender-built clusters of squashed icosahedrons, instanced and drifting on the wind.
- **Lighting:** hemisphere fill + a directional sun with PCF soft shadows that follows the player so the shadow frustum always covers the action.

### Rebuilding the assets

The shipped `.glb` files in `public/assets/models/` are checked in, so **you do not need Blender to run the game**. If you want to edit the models, open the `.blend` files in `blender/` in Blender 4.x/5.x. To rebuild all `.glb` files from the scripts headlessly:

```bash
# Windows (Blender on PATH or at default install)
blender\build_all.bat

# Or manually:
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python blender/build_player_jet.py
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python blender/build_enemy_jet.py
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python blender/build_helicopter.py
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python blender/build_props.py
```

### Asset → script map

| Asset | Blender script | `.blend` | `.glb` |
|---|---|---|---|
| Player jet | `blender/build_player_jet.py` | `blender/player_jet.blend` | `public/assets/models/player_jet.glb` |
| Enemy jet | `blender/build_enemy_jet.py` | `blender/enemy_jet.blend` | `public/assets/models/enemy_jet.glb` |
| Helicopter | `blender/build_helicopter.py` | `blender/helicopter.blend` | `public/assets/models/helicopter.glb` |
| Missile / Tree / Rock / Cloud | `blender/build_props.py` | `blender/*.blend` | `public/assets/models/*.glb` |
| Explosion / Debris / Muzzle / Ember | `blender/build_vfx.py` | `blender/vfx_*.blend` | `public/assets/models/vfx_*.glb` |

---

## 💥 VFX — destruction, fire and gunfire

Built in Blender by `blender/build_vfx.py` and driven at runtime by `src/vfx.js`.

**Blender owns the forms, the runtime owns the motion and the shading.** Baking the animation into the assets — a simulated fireball flipbook, keyframed debris — would cost megabytes and still play back identically on every kill.

| Asset | Triangles | Contents |
|---|---|---|
| `vfx_explosion.glb` | 5,504 | 3 nested fire shells, a shockwave ring, 4 smoke billows |
| `vfx_debris.glb` | 194 | 10 chunks: torn panels, structural pieces with spars, an engine section |
| `vfx_muzzle.glb` | 351 | 9-point flash star, propellant cone, smoke puff |
| `vfx_ember.glb` | 6 | one tapered spark shard, drawn as an InstancedMesh |

These are **deliberately low poly**, the one exception to the 90k budget. You fly behind the player jet for the whole game, so it earns its polygons; a single kill instead puts a fireball, a shockwave, eight debris chunks, four smoke billows and a hundred embers on screen in one frame.

### What Blender is responsible for: silhouette

The single biggest reason a real-time explosion reads as fake is a **hard, regular edge** — a smooth sphere is recognisable as a sphere no matter how it's coloured. So the shapes are broken up two ways: multi-octave noise displacement, so no silhouette arc is ever a clean curve; and **radial plumes**, a handful of directions pushed much further out than the rest. Real blasts burst unevenly through whatever gives way first, and those lobes are what make it read as combustion rather than a ball of fire. Smoke is built as *clusters* of lobes (cauliflower), not single spheres, because billowing comes from the shape, not the shading.

Tessellation is set by what the shader needs, not the silhouette: the fire fades on the angle between surface and eye, and below icosphere subdivision 4 that gradient visibly facets into triangles.

### What the shader is responsible for: everything per-pixel

A textured or vertex-coloured sphere always reads as a sphere. Four things separate fire from a glowing ball, and all four change every frame:

1. **No hard edge.** A solid mesh standing in for a volume fades where the surface turns away from the eye — a ray through the middle crosses far more fire than one at the rim. Measured across a fireball, intensity ramps over ~8–10 px at each edge instead of stepping.
2. **Churn.** A domain-warped noise field drifts through the shell so it boils instead of uniformly scaling.
3. **Temperature, not colour.** A blackbody ramp driven by the noise puts white cores and dull red fringes in the same frame. Measured mid-life: **11% white / 71% orange / 18% sooty dark** across 56 distinct colour buckets — a small white core in a large orange body, which is what real fire looks like.
4. **Dissolve, not fade.** Eroding alpha against the noise with a rising threshold breaks the fireball into wisps; lowering opacity uniformly just makes a ghost ball.

### The rest of the blast

- **It lights the world.** A pooled `PointLight` flares to peak in 0.15 s and is gone by 1.2 s. An explosion that doesn't illuminate what's around it is the clearest tell that it's a sprite pasted over the scene. Lights are allocated once and never added or removed — changing the light count forces THREE to recompile every affected material, which would stutter on exactly the frame a blast goes off.
- **Embers.** A hundred shards thrown per kill, stretched along their own velocity so fast ones streak and slow ones read as dots, each flickering on its own phase. Drawn as one `InstancedMesh` — as separate meshes that would be a hundred draw calls for a dozen pixels each.
- **Smoke outlives fire by five seconds.** Fire dies at ~1.3 s; the column is still rising and growing at 6.5 s (measured: 57 units of rise, 2.8× growth). Tying both to one lifetime is why game explosions so often vanish all at once.
- **The shockwave outruns the fireball** and dies first — the cue that something *detonated* rather than merely caught fire.
- **Debris inherits the victim's velocity**, so wreckage comes *off* an aircraft rather than being emitted by a point, falls under the flight model's gravity, and sheds sparks while it's still hot.
- **Secondary detonations** stagger 0.1–0.34 s behind aircraft-sized kills; fuel and ordnance don't all go up in the same instant.

### Cost

Everything is **pooled**, and concurrent explosions are **capped at 10** — smoke lingering for seconds is what stacks them up, and each is seven overlapping transparent meshes. Without the cap a twelve-kill wave left 29 live at once. The noise runs a 2-octave domain warp feeding a 3-octave detail pass rather than 4+4; that alone cut the fragment cost ~40%.

Worst case measured (10 simultaneous full-size blasts filling the screen, 320 embers, 48 debris) costs **2.75× a quiet frame**, down from 4.7× before the cap and the cheaper noise. Note these timings come from a software-WebGL context, which is far more fragment-bound than real hardware — treat the *ratio* as meaningful and the absolute milliseconds as pessimistic.

Effects update **outside** the `state === 'playing'` guard, so the player's own death explosion plays out instead of freezing on its first frame.

---

## 📁 Project structure

```
jet-game/
├── index.html              # Vite entry: canvas mount + HUD + menus
├── vite.config.js          # Dev server + build config
├── package.json
├── README.md
├── src/
│   ├── styles.css          # HUD styling, menus, animations
│   ├── main.js             # Bootstrap, state machine, game loop, waves, collisions
│   ├── assets.js           # Async GLTFLoader cache + clone/material helpers
│   ├── models.js           # Facade: hands out glb clones with runtime hooks wired
│   ├── world.js            # Procedural environment: terrain, ocean, islands, sky
│   ├── player.js           # Player flight physics + chase camera
│   ├── enemies.js          # Enemy AI (jet/helo), bullets, homing missiles, trails
│   ├── particles.js        # GPU particle system: smoke, sparks, trails
│   ├── vfx.js              # Pooled Blender VFX + fire/smoke shaders, embers, flash lights
│   ├── input.js            # Keyboard + mouse with pointer lock
│   ├── audio.js            # Procedural Web Audio SFX + engine drone
│   ├── hud.js              # HUD: bars, score, radar canvas
│   └── utils.js            # Math, RNG, material helpers
├── blender/                # Blender asset sources + build scripts
│   ├── bpy_helpers.py      # Shared: materials, flat-shade, primitives, glb export
│   ├── build_player_jet.py
│   ├── build_enemy_jet.py
│   ├── build_helicopter.py
│   ├── build_props.py      # Missile, tree, rock, cloud
│   ├── build_vfx.py        # Explosion, debris, muzzle flash
│   ├── build_all.bat       # Rebuild every .glb headlessly
│   └── *.blend             # Editable Blender source files
└── public/                 # Served verbatim; copied to dist/ on build
    └── assets/
        └── models/         # Exported .glb files (loaded at runtime)
            ├── player_jet.glb
            ├── enemy_jet.glb
            ├── helicopter.glb
            ├── missile.glb
            ├── tree.glb
            ├── rock.glb
            ├── cloud.glb
            ├── vfx_explosion.glb
            ├── vfx_debris.glb
            ├── vfx_muzzle.glb
            └── vfx_ember.glb
```

Three.js is installed from npm (`three`) and bundled by Vite. The `.glb` models live in `public/`, so Vite serves them as-is in dev and copies them into `dist/` on build.

### Asset budget & LOD

Every model is authored to **90,000–91,000 triangles** (`normalize_tris()` in `blender/bpy_helpers.py` enforces the window). Detail is structural, not smoothing — separate control surfaces, intake ducts, nozzle petals, cockpit interiors, pylons and ordnance, plus a **two-pass panel inset** that recesses each face and then subdivides those panels into individually seamed plates. The player jet authors ~158k triangles of real plating (the enemy jet ~209k) and is then decimated to budget, so the polygons are relief the key light can pick out rather than a denser approximation of the same shape.

| Asset | LOD0 | LOD1 | LOD2 | LOD3 |
|---|---|---|---|---|
| player_jet / enemy_jet / helicopter | ~90.3k | 20–30k | — | — |
| missile | 90,494 | — | — | — |
| tree | 90,496 | 25,320 | 6,761 | 1,808 |
| rock | 90,490 | 25,334 | 6,767 | 1,805 |
| cloud | 90,484 | 25,326 | 6,767 | 1,807 |

Trees, rocks and clouds are instanced **~246×** across the archipelago, so each ships a decimated LOD chain in the same `.glb`. `getLOD()` in `src/assets.js` reads the `<Name>_LOD0..3` nodes into a `THREE.LOD`; the renderer swaps levels itself. In flight most props sit at LOD2/LOD3 — measured at cruise: 151 at LOD3, 87 at LOD2, 11 at LOD1, none at LOD0. Aircraft now carry LOD too (`applyAirframeLOD` in `src/models.js`): only the merged hull swaps, while flames, glows, nav lights and rotors stay outside it so the runtime hooks still resolve and still render at any range. The whole scene renders at **181 draws / 504k triangles** cruising, **271 / 682k** low over the dense island cluster, and **68 / 343k** with thirteen enemies airborne — without the airframe LOD that last case measured 152 draws / 971k.

Two further things keep it cheap: each LOD level is **merged to a single multi-material mesh** in Blender (a 98-part airframe would otherwise be 98 draw calls, ×10 enemies), and clones **share geometry buffers** — 249 instances use 61 geometries. Models are **Draco-compressed** on export (~60 MB → 6.4 MB), decoded by a locally bundled decoder in `public/draco/` (no CDN).

---

## ⚙️ Tech & techniques

- **Three.js r160** (npm `three`, bundled by **Vite**)
- **Blender 5.2** `bpy` scripts author all aircraft & prop assets; exported to **glTF `.glb`**
- **GLTFLoader** fetches & caches models at startup, then `clone()` per instance
- **Pointer Lock API** for mouse-flight steering
- **Custom GLSL** for the gradient sky shader and the particle point shader
- **FBM value noise** for terrain heightfields and coastline carving
- **Object/material cloning** for bullets, particles, enemies, and scenery to keep GC quiet and per-instance state isolated
- **Web Audio API** for fully synthesized sound (engine drone, gunfire, explosions, UI) — no audio files
- **ACES filmic tone mapping** + colored distance fog for a cinematic look

---

## 🔧 Tuning & extending

Common knobs to tweak:

- **Difficulty:** in `src/main.js` → `startNextWave()` changes `jets`/`helos` counts per wave.
- **Player feel:** in `src/player.js` → `minSpeed`, `maxSpeed`, steering `resp`, and `BOUND` (world radius).
- **World size / islands:** in `src/world.js` → `WORLD_RADIUS`, ring count, island radii.
- **Add a new enemy type:** create a builder in `src/models.js`, add a class in `src/enemies.js`, spawn it from `startNextWave()`.

Enjoy, pilot. 🛩️💥
