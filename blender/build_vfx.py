"""
build_vfx.py — VFX geometry: fireball shells, smoke billows, embers, debris,
muzzle flashes and shockwaves.
Output: blender/vfx_*.blend + public/assets/models/vfx_*.glb

Deliberately LOW poly, unlike every other asset here. The airframes sit at a
90k budget because you fly behind one of them for the whole game; VFX are the
opposite case — a single kill can put a fireball, a shockwave, eight debris
chunks, four smoke billows and a hundred embers on screen inside one frame, each
alive for a second or two. Spending 90k on any of them would drop the frame rate
exactly when the most is happening.

WHAT THIS FILE IS RESPONSIBLE FOR
---------------------------------
Silhouette. Everything else — churn, temperature, dissolve — is a shader
(src/vfx.js), because those are per-pixel and change every frame.

The single biggest reason a real-time explosion reads as fake is a *hard,
regular edge*: a smooth sphere is instantly recognisable as a sphere no matter
how it is coloured. So the shapes here are deliberately broken up two ways:

  1. Multi-octave noise displacement, so no silhouette arc is ever a clean curve.
  2. Radial PLUMES — a handful of directions pushed much further out than the
     rest. Real blasts burst unevenly through the path of least resistance;
     the lobes are what make it read as an explosion instead of a ball of fire.

Smoke is built as CLUSTERS of lobes (cauliflower), not single spheres, for the
same reason — billowing is the defining visual of a smoke column, and it comes
from the shape, not the shading.

Tessellation is set by what the shader needs, not by the silhouette: the fire
shader fades on the angle between the surface and the eye, so a coarse mesh
would show faceted banding across the fireball. Icosphere subdivision 3 is the
point where that banding stops being visible.
"""
import bpy
import math
import os
import sys
import random

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from bpy_helpers import (
    reset_scene, mat, hex_to_rgb, cone, cylinder, cube, ico, uv_sphere, torus,
    group, flat_shade, assign, save_blend, export_glb, TAU,
    smooth_all, collect_meshes, join_meshes, apply_scale, select_only,
)

MODELS_DIR = os.path.join(HERE, "..", "public", "assets", "models")
os.makedirs(MODELS_DIR, exist_ok=True)


def _save(name):
    blend_path = os.path.join(HERE, f"{name}.blend")
    glb_path = os.path.join(MODELS_DIR, f"{name}.glb")
    save_blend(blend_path)
    export_glb(glb_path)
    size = os.path.getsize(glb_path) if os.path.exists(glb_path) else 0
    print(f"VFX_SAVED {name}: glb={os.path.exists(glb_path)} size={size}")


# ---------------------------------------------------------------------------
# Deterministic value noise. Same build every run, so a rebuild never silently
# reshapes the effects.
# ---------------------------------------------------------------------------
def _hash3(i, j, k, seed):
    n = i * 374761393 + j * 668265263 + k * 1274126177 + int(seed * 9176)
    n &= 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    n ^= (n >> 16)
    return (n & 0x7FFFFFFF) / 0x3FFFFFFF - 1.0


def _vnoise(x, y, z, seed=0.0):
    xi, yi, zi = math.floor(x), math.floor(y), math.floor(z)
    xf, yf, zf = x - xi, y - yi, z - zi
    u = xf * xf * (3 - 2 * xf)
    v = yf * yf * (3 - 2 * yf)
    w = zf * zf * (3 - 2 * zf)
    xi, yi, zi = int(xi), int(yi), int(zi)

    def c(dx, dy, dz):
        return _hash3(xi + dx, yi + dy, zi + dz, seed)

    x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u
    x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u
    x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u
    x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u
    return (x00 + (x10 - x00) * v) + ((x01 + (x11 - x01) * v) - (x00 + (x10 - x00) * v)) * w


def _fbm(x, y, z, octaves=4, seed=0.0):
    total, amp, freq, norm = 0.0, 1.0, 1.0, 0.0
    for _ in range(octaves):
        total += amp * _vnoise(x * freq, y * freq, z * freq, seed)
        norm += amp
        amp *= 0.5
        freq *= 2.03          # not exactly 2, so octaves never line up
    return total / norm


def _turbulize(obj, freq=2.4, amp=0.22, octaves=4, seed=1.0, plumes=(), plume_amp=0.0):
    """Break the silhouette: fbm displacement plus a few radial plumes.

    The fbm removes the clean curve. The plumes are the part that actually reads
    as an explosion — real blasts burst unevenly through whatever gives way
    first, so a fireball with three or four lobes bulging out of it looks like
    combustion, and a uniformly bumpy sphere still looks like a sphere.
    """
    for vert in obj.data.vertices:
        p = vert.co
        length = p.length or 1e-6
        n = _fbm(p.x * freq, p.y * freq, p.z * freq, octaves, seed)
        scale = 1.0 + n * amp

        if plumes and plume_amp:
            dx, dy, dz = p.x / length, p.y / length, p.z / length
            best = -1.0
            for (px, py, pz) in plumes:
                d = dx * px + dy * py + dz * pz
                if d > best:
                    best = d
            # Only the cap around each plume direction moves, with a soft
            # shoulder, so the lobe grows out of the body instead of denting it.
            lobe = max(0.0, (best - 0.45) / 0.55) ** 1.7
            scale += lobe * plume_amp
        vert.co = p * scale
    obj.data.update()
    return obj


def _plume_dirs(count, rng):
    dirs = []
    for _ in range(count):
        z = rng.uniform(-1.0, 1.0)
        a = rng.uniform(0.0, TAU)
        r = math.sqrt(max(0.0, 1.0 - z * z))
        dirs.append((math.cos(a) * r, math.sin(a) * r, z))
    return dirs


# ---------------------------------------------------------------------------
def build_explosion():
    """Nested fireball shells, a shockwave ring, and billowing smoke.

    Three shells rather than one: the runtime expands, cools and dissolves them
    at different rates, so the core burns out while the outer shell balloons
    into smoke. That layering is what sells the blast as a volume rather than a
    growing ball — a single shell can only ever be one temperature at one
    radius, and real fire is hot inside and cool at the fringe simultaneously.
    """
    reset_scene()
    # These base colours barely matter — the fire shader computes its own
    # blackbody ramp per pixel. They exist so the .blend is readable when opened
    # by hand, and so the glb has a sane fallback if the shader is ever dropped.
    m_core = mat("X_Core",  0xfff2c0, emission=hex_to_rgb(0xfff0b0), emission_strength=6.0)
    m_mid  = mat("X_Mid",   0xff8c2a, emission=hex_to_rgb(0xff7a18), emission_strength=3.2)
    m_out  = mat("X_Outer", 0x8a3a12, emission=hex_to_rgb(0x6e2a08), emission_strength=1.0)
    m_wave = mat("X_Wave",  0xffd9a0, emission=hex_to_rgb(0xffcf90), emission_strength=2.2)
    m_smoke = mat("X_Smoke", 0x2a2622, metallic=0.0, roughness=1.0)

    root = group("Explosion", (0, 0, 0))
    rng = random.Random(7)

    # Shells. Radius ~1 by convention — the runtime scales them, so every
    # explosion size reuses the same geometry.
    #
    # Subdivision 4 (1280 tris — Blender counts subdivision 1 as a bare
    # icosahedron) is chosen by the shader, not the shape: the fire fades on
    # view angle, and at subdivision 3 that gradient visibly facets into
    # triangles across the fireball.
    for name, r, amp, plume_n, plume_amp, m, seed in (
        ("FireCore",  0.58, 0.16, 3, 0.20, m_core, 3.0),
        ("FireMid",   0.82, 0.24, 4, 0.30, m_mid,  9.0),
        ("FireOuter", 1.05, 0.32, 5, 0.42, m_out,  17.0),
    ):
        s = ico(name, radius=r, subdivisions=4, location=(0, 0, 0), material=m)
        _turbulize(s, freq=2.2, amp=amp, octaves=4, seed=seed,
                   plumes=_plume_dirs(plume_n, rng), plume_amp=plume_amp)
        s.parent = root

    # Shockwave: a flat expanding ring. The readable cue that something
    # *detonated* rather than merely caught fire — without it a fireball reads
    # as a fuel fire, with it as an explosion.
    wave = torus("Shockwave", major_radius=1.0, minor_radius=0.055,
                 major_segments=64, minor_segments=6, material=m_wave)
    wave.scale = (1.0, 1.0, 0.18)
    apply_scale(wave)
    wave.parent = root

    # Smoke billows, each a CLUSTER of lobes rather than a sphere. Billowing is
    # the defining silhouette of a smoke column and it comes from the shape:
    # a noise-bumped sphere still reads as a sphere, a cauliflower does not.
    for i in range(4):
        b = ico(f"Smoke{i}", radius=rng.uniform(0.42, 0.70), subdivisions=3,
                location=(rng.uniform(-0.55, 0.55), rng.uniform(-0.55, 0.55),
                          rng.uniform(-0.40, 0.60)),
                material=m_smoke)
        _turbulize(b, freq=1.7, amp=0.30, octaves=3, seed=40.0 + i * 7,
                   plumes=_plume_dirs(rng.randint(3, 5), rng), plume_amp=0.46)
        b.parent = root

    smooth_all(root, 70.0)
    print("EXPLOSION_TRIS:", sum(len(m.data.polygons) for m in collect_meshes(root)))
    _save("vfx_explosion")


# ---------------------------------------------------------------------------
def build_ember():
    """A single tapered ember shard, drawn as an InstancedMesh at runtime.

    Embers are the cheapest realism in the whole system. A fireball alone reads
    as a decal pasted over the sky; burning fragments thrown out of it, falling
    on their own arcs and winking out at different times, are what give the
    blast a real position and scale in the world.

    One shard, instanced a few hundred times — separate meshes would be a few
    hundred draw calls for something that covers a dozen pixels each.
    """
    reset_scene()
    m_ember = mat("E_Ember", 0xffb347, emission=hex_to_rgb(0xff8a10), emission_strength=9.0)

    root = group("Ember", (0, 0, 0))
    # Tapered, not spherical: an ember tumbling on its long axis flickers as it
    # turns, which is most of what makes a spark look alive.
    shard = cone("EmberShard", radius=0.10, depth=0.55, vertices=5,
                 rotation=(math.radians(90), 0, 0), material=m_ember)
    shard.parent = root

    print("EMBER_TRIS:", sum(len(m.data.polygons) for m in collect_meshes(root)))
    _save("vfx_ember")


# ---------------------------------------------------------------------------
def build_debris():
    """Torn airframe pieces.

    Angular and asymmetric on purpose: debris reads as *wreckage* because the
    silhouette is broken. Rounded lumps read as rocks. Each chunk is a separate
    named node so the runtime can pick a mix per kill rather than always
    scattering the same shape.
    """
    reset_scene()
    m_hull  = mat("D_Hull",  0x6a7280, metallic=0.55, roughness=0.55)
    m_dark  = mat("D_Dark",  0x2a2f36, metallic=0.35, roughness=0.75)
    m_burnt = mat("D_Burnt", 0x171412, metallic=0.20, roughness=0.95)

    root = group("Debris", (0, 0, 0))
    rng = random.Random(11)

    # Panel shards — flat, bent plates. The most common wreckage.
    for i in range(3):
        p = cube(f"Chunk{i}", size=(rng.uniform(0.5, 1.1), rng.uniform(0.4, 0.9), 0.06),
                 material=m_hull if i % 2 == 0 else m_dark)
        for v in p.data.vertices:                      # tear the edges
            v.co.x += rng.uniform(-0.16, 0.16)
            v.co.y += rng.uniform(-0.16, 0.16)
            v.co.z += rng.uniform(-0.05, 0.05)
        p.data.update()
        p.parent = root

    # Structural chunks — thicker, with a spar sticking out.
    for i in range(3, 6):
        c = cube(f"Chunk{i}", size=(rng.uniform(0.35, 0.6), rng.uniform(0.3, 0.5),
                                    rng.uniform(0.25, 0.45)),
                 material=m_burnt if i == 5 else m_hull)
        for v in c.data.vertices:
            v.co.x += rng.uniform(-0.12, 0.12)
            v.co.y += rng.uniform(-0.12, 0.12)
            v.co.z += rng.uniform(-0.12, 0.12)
        c.data.update()
        spar = cylinder(f"Chunk{i}_spar", radius=0.035, depth=rng.uniform(0.4, 0.8),
                        vertices=6, material=m_dark)
        spar.rotation_euler = (rng.uniform(0, 1.2), rng.uniform(0, 1.2), 0)
        spar.parent = c
        c.parent = root

    # Engine section — recognisable, so a kill reads as an aircraft coming apart.
    eng = cylinder("Chunk6", radius=0.30, depth=0.75, vertices=12, material=m_dark)
    ring = torus("Chunk6_ring", major_radius=0.30, minor_radius=0.045,
                 major_segments=12, minor_segments=5,
                 location=(0, 0, 0.36), material=m_burnt)
    ring.parent = eng
    eng.parent = root

    # Small shards for volume.
    for i in range(7, 10):
        s = ico(f"Chunk{i}", radius=rng.uniform(0.10, 0.20), subdivisions=1,
                material=m_burnt)
        _turbulize(s, freq=4.0, amp=0.45, octaves=2, seed=70.0 + i)
        s.parent = root

    smooth_all(root, 34.0)
    print("DEBRIS_TRIS:", sum(len(m.data.polygons) for m in collect_meshes(root)))
    _save("vfx_debris")


# ---------------------------------------------------------------------------
def build_muzzle():
    """Gun muzzle flash: a star burst, a short cone, and a smoke puff.

    Three forms because a flash is three things at once — a point of light, a
    jet of burning propellant, and the smoke it leaves behind. The runtime shows
    the first two for two or three frames, randomly rolled about the barrel
    axis so repeated fire never strobes the identical shape, and lets the smoke
    linger.
    """
    reset_scene()
    m_flash = mat("F_Flash", 0xfff4d0, emission=hex_to_rgb(0xfff0c0), emission_strength=8.0)
    m_warm  = mat("F_Warm",  0xffb347, emission=hex_to_rgb(0xff9a1f), emission_strength=4.0)
    m_puff  = mat("F_Puff",  0x6b6560, metallic=0.0, roughness=1.0)

    root = group("Muzzle", (0, 0, 0))
    rng = random.Random(23)

    # Star: alternating long and short spikes on a flat disc, with the spike
    # lengths jittered so the burst is irregular rather than a clean asterisk.
    verts, faces = [(0.0, 0.0, 0.0)], []
    spikes = 9
    for i in range(spikes * 2):
        a = i * (TAU / (spikes * 2))
        r = rng.uniform(0.78, 1.0) if i % 2 == 0 else rng.uniform(0.26, 0.42)
        verts.append((math.cos(a) * r, math.sin(a) * r, 0.0))
    for i in range(1, spikes * 2):
        faces.append((0, i, i + 1))
    faces.append((0, spikes * 2, 1))
    mesh = bpy.data.meshes.new("FlashStar_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    star = bpy.data.objects.new("FlashStar", mesh)
    bpy.context.collection.objects.link(star)
    assign(star, m_flash)
    flat_shade(star)
    star.parent = root

    # Short forward cone — the propellant jet.
    jet = cone("FlashCone", radius=0.34, depth=1.0, vertices=12,
               location=(0, 0, 0.5), material=m_warm)
    jet.rotation_euler = (0, 0, 0)
    jet.parent = root

    # Smoke puff left hanging at the barrel.
    puff = ico("FlashPuff", radius=0.26, subdivisions=3, location=(0, 0, 0.28),
               material=m_puff)
    _turbulize(puff, freq=2.6, amp=0.30, octaves=3, seed=61.0,
               plumes=_plume_dirs(3, rng), plume_amp=0.34)
    puff.parent = root

    smooth_all(root, 70.0)
    print("MUZZLE_TRIS:", sum(len(m.data.polygons) for m in collect_meshes(root)))
    _save("vfx_muzzle")


if __name__ == "__main__":
    build_explosion()
    build_ember()
    build_debris()
    build_muzzle()
    print("VFX_DONE")
