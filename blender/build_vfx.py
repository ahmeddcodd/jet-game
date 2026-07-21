"""
build_vfx.py — VFX geometry: explosion shells, debris chunks, muzzle flashes.
Output: blender/vfx_*.blend + public/assets/models/vfx_*.glb

Deliberately LOW poly, unlike every other asset here. The airframes sit at a
90k budget because you fly behind one of them for the whole game; VFX are the
opposite case — a single kill can put an explosion, a shockwave, eight debris
chunks and a dozen smoke puffs on screen inside one frame, each alive for a
second or two. Spending 90k on any of them would drop the frame rate exactly
when the most is happening. Each piece here is a few hundred triangles, which
is all a shape lasting 400 ms and covered in emissive needs.

The division of labour: Blender authors the FORMS, the runtime animates them
(see src/vfx.js). Baking the motion into Blender — a simulated fireball flipbook
or keyframed debris — would cost megabytes of texture or animation data, and
still look identical on every kill. Driving simple forms in code is cheaper and
gives every explosion different debris directions, spin and timing.
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


def _roughen(obj, amp, seed):
    """Push vertices out along a deterministic noise field.

    A perfect sphere never reads as fire or as a torn-off piece of aircraft —
    both are defined by their irregular silhouette, which is the first thing the
    eye picks up when the shape is on screen for only a few frames.
    """
    rng = random.Random(seed)
    for v in obj.data.vertices:
        n = (math.sin(v.co.x * 3.7 + seed) * math.cos(v.co.y * 2.9 - seed)
             + math.sin(v.co.z * 4.1 + seed * 0.7))
        v.co *= 1.0 + n * amp * 0.4 + rng.uniform(-amp, amp) * 0.6
    obj.data.update()
    return obj


# ---------------------------------------------------------------------------
def build_explosion():
    """Nested fireball shells, a shockwave ring and smoke blobs.

    Three shells rather than one: the runtime expands and fades them at
    different rates, so the core outruns nothing while the outer shell balloons
    and goes to smoke. That layering is what sells an explosion as a volume
    rather than a growing ball.
    """
    reset_scene()
    m_core = mat("X_Core",  0xfff2c0, emission=hex_to_rgb(0xfff0b0), emission_strength=6.0)
    m_mid  = mat("X_Mid",   0xff8c2a, emission=hex_to_rgb(0xff7a18), emission_strength=3.2)
    m_out  = mat("X_Outer", 0x8a3a12, emission=hex_to_rgb(0x6e2a08), emission_strength=1.0)
    m_wave = mat("X_Wave",  0xffd9a0, emission=hex_to_rgb(0xffcf90), emission_strength=2.2)
    m_smoke = mat("X_Smoke", 0x2a2622, metallic=0.0, roughness=1.0)

    root = group("Explosion", (0, 0, 0))

    # Shells. Radius 1 by convention — the runtime scales them, so every
    # explosion size uses the same geometry.
    for name, r, sub, amp, m, seed in (
        ("FireCore",  0.55, 2, 0.16, m_core, 3),
        ("FireMid",   0.80, 2, 0.22, m_mid,  9),
        ("FireOuter", 1.00, 2, 0.30, m_out,  17),
    ):
        s = ico(name, radius=r, subdivisions=sub, location=(0, 0, 0), material=m)
        _roughen(s, amp, seed)
        s.parent = root

    # Shockwave: a flat expanding ring, the readable cue that something
    # detonated rather than merely caught fire.
    wave = torus("Shockwave", major_radius=1.0, minor_radius=0.055,
                 major_segments=40, minor_segments=6, material=m_wave)
    wave.scale = (1.0, 1.0, 0.22)
    apply_scale(wave)
    wave.parent = root

    # Smoke blobs, scattered so the cloud is lumpy from the first frame.
    rng = random.Random(5)
    for i in range(5):
        b = ico(f"Smoke{i}", radius=rng.uniform(0.36, 0.62), subdivisions=1,
                location=(rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5),
                          rng.uniform(-0.35, 0.55)),
                material=m_smoke)
        _roughen(b, 0.26, 40 + i * 7)
        b.parent = root

    smooth_all(root, 60.0)
    print("EXPLOSION_TRIS:", sum(len(m.data.polygons) for m in collect_meshes(root)))
    _save("vfx_explosion")


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
        _roughen(s, 0.45, 70 + i)
        s.parent = root

    smooth_all(root, 34.0)
    print("DEBRIS_TRIS:", sum(len(m.data.polygons) for m in collect_meshes(root)))
    _save("vfx_debris")


# ---------------------------------------------------------------------------
def build_muzzle():
    """Gun muzzle flash: a star burst and a short cone.

    Two forms because a flash is both a point of light and a jet of burning
    propellant. The runtime shows them for two or three frames, randomly rolled
    about the barrel axis so repeated fire never strobes the identical shape.
    """
    reset_scene()
    m_flash = mat("F_Flash", 0xfff4d0, emission=hex_to_rgb(0xfff0c0), emission_strength=8.0)
    m_warm  = mat("F_Warm",  0xffb347, emission=hex_to_rgb(0xff9a1f), emission_strength=4.0)

    root = group("Muzzle", (0, 0, 0))

    # Star: alternating long and short spikes on a flat disc.
    verts, faces = [(0.0, 0.0, 0.0)], []
    spikes = 7
    for i in range(spikes * 2):
        a = i * (TAU / (spikes * 2))
        r = 1.0 if i % 2 == 0 else 0.36
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
    jet = cone("FlashCone", radius=0.34, depth=1.0, vertices=10,
               location=(0, 0, 0.5),
               rotation=(math.radians(-90), 0, 0), material=m_warm)
    jet.rotation_euler = (0, 0, 0)
    jet.parent = root

    print("MUZZLE_TRIS:", sum(len(m.data.polygons) for m in collect_meshes(root)))
    _save("vfx_muzzle")


if __name__ == "__main__":
    build_explosion()
    build_debris()
    build_muzzle()
    print("VFX_DONE")
