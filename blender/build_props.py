"""
build_props.py — environment props + missile, built in Blender.
Builds and exports: missile, tree, rock, cloud
Output: blender/*.blend + public/assets/models/*.glb

Target: 10,000-11,000 triangles for every LOD0.

Trees, rocks and clouds are instanced ~225x across the archipelago, so each one
also ships a decimated LOD1/LOD2/LOD3 chain in the same glb. The runtime reads
those into a THREE.LOD, which is what makes 10k-poly scenery affordable — full
detail is only ever paid for on the handful of props near the camera.

The missile is short-lived and small on screen, so it stays LOD0-only.
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
    panel_inset, normalize_tris, total_tris, apply_scale, build_lod_chain,
    subdivide_mesh, collect_meshes, join_meshes, join_except,
)

MODELS_DIR = os.path.join(HERE, "..", "public", "assets", "models")
os.makedirs(MODELS_DIR, exist_ok=True)

TRI_LO, TRI_HI = 10000, 11000

# LOD ratios relative to LOD0. Tuned so LOD2 (the level most scenery sits at
# during normal flight) costs under a thousand triangles.
SCENERY_LODS = (0.28, 0.075, 0.02)


def _flatten_lods(root, lods, name):
    """Merge each LOD level down to a single multi-material mesh.

    Scenery is instanced ~225x, so per-level draw calls are multiplied by the
    instance count — merging is what keeps a 10k-poly tree from costing 17 draw
    calls every time it appears.
    """
    join_meshes(collect_meshes(root), f"{name}_LOD0_mesh")
    for i, holder in enumerate(lods, start=1):
        join_meshes(collect_meshes(holder), f"{name}_LOD{i}_mesh")


def _save(name, root, lods=None):
    blend_path = os.path.join(HERE, f"{name}.blend")
    glb_path = os.path.join(MODELS_DIR, f"{name}.glb")
    save_blend(blend_path)
    export_glb(glb_path)
    size = os.path.getsize(glb_path) if os.path.exists(glb_path) else 0
    extra = ""
    if lods:
        extra = " lods=" + ",".join(str(total_tris(h)) for h in lods)
    print(f"PROP_SAVED {name}: glb={os.path.exists(glb_path)} size={size}"
          f" lod0_tris={total_tris(root)}{extra}")


def _jitter(obj, amp, seed):
    """Push vertices along a deterministic pseudo-noise field — turns a smooth
    subdivided sphere into something that reads as eroded stone or cloud."""
    rng = random.Random(seed)
    for v in obj.data.vertices:
        # Position-seeded so the same vertex always moves the same way.
        n = math.sin(v.co.x * 3.1 + seed) * math.cos(v.co.y * 2.7 - seed) \
            + math.sin(v.co.z * 4.3 + seed * 0.5)
        f = 1.0 + n * amp * 0.35 + rng.uniform(-amp, amp) * 0.4
        v.co *= f
    obj.data.update()
    return obj


# ---------------------------------------------------------------------------
def build_missile():
    reset_scene()
    m_body = mat("M_Body", 0xd8dde2, metallic=0.40, roughness=0.40)
    m_tip  = mat("M_Tip",  0xff4444, metallic=0.10, roughness=0.50)
    m_fin  = mat("M_Fin",  0x8a9098, metallic=0.20, roughness=0.60)
    m_dark = mat("M_Dark", 0x3a4048, metallic=0.30, roughness=0.60)
    m_glow = mat("M_Glow", 0xffcc66, emission=hex_to_rgb(0xffcc66), emission_strength=2.0)

    root = group("Missile", (0, 0, 0))
    detail = []

    def part(o, panels=False):
        o.parent = root
        if panels:
            detail.append(o)
        return o

    # Airframe in three sections so a joint line reads at each break
    part(cylinder("BodyFwd", radius=0.12, depth=0.62, vertices=16,
                  location=(0, 0.50, 0), rotation=(math.radians(90), 0, 0),
                  material=m_body), panels=True)
    part(cylinder("BodyMid", radius=0.125, depth=0.86, vertices=16,
                  location=(0, -0.20, 0), rotation=(math.radians(90), 0, 0),
                  material=m_body), panels=True)
    part(cylinder("BodyAft", radius=0.12, depth=0.42, vertices=16,
                  location=(0, -0.82, 0), rotation=(math.radians(90), 0, 0),
                  material=m_dark), panels=True)

    # Seeker head
    part(cone("Tip", radius=0.12, depth=0.42, vertices=16,
              location=(0, 1.00, 0), rotation=(math.radians(-90), 0, 0), material=m_tip))
    part(uv_sphere("Seeker", radius=0.075, segments=14, rings=8,
                   location=(0, 1.20, 0), material=m_dark))

    # Section joint bands
    for i, y in enumerate((0.19, -0.63)):
        part(torus(f"Band{i}", major_radius=0.128, minor_radius=0.018,
                   major_segments=16, minor_segments=6,
                   location=(0, y, 0), rotation=(math.radians(90), 0, 0),
                   material=m_dark))

    # Mid-body strakes + tail fins with actuator fairings
    for i in range(4):
        a = i * (TAU / 4) + math.radians(45)
        strake = cube(f"Strake{i}", size=(0.03, 0.70, 0.16),
                      location=(math.cos(a) * 0.16, 0.20, math.sin(a) * 0.16),
                      material=m_fin)
        strake.rotation_euler = (a, 0, 0)
        part(strake)

        fin = cube(f"Fin{i}", size=(0.03, 0.34, 0.30),
                   location=(math.cos(a) * 0.20, -0.86, math.sin(a) * 0.20),
                   material=m_fin)
        fin.rotation_euler = (a, 0, 0)
        part(fin)

        act = cylinder(f"Actuator{i}", radius=0.035, depth=0.22, vertices=8,
                       location=(math.cos(a) * 0.13, -0.80, math.sin(a) * 0.13),
                       rotation=(math.radians(90), 0, 0), material=m_dark)
        part(act)

    # Nozzle + exhaust glow
    part(cylinder("Nozzle", radius=0.115, depth=0.16, vertices=16, radius2=0.085,
                  location=(0, -1.06, 0), rotation=(math.radians(-90), 0, 0),
                  material=m_dark))
    part(cylinder("Glow", radius=0.085, depth=0.05, vertices=14,
                  location=(0, -1.16, 0), rotation=(math.radians(90), 0, 0),
                  material=m_glow))

    for o in detail:
        panel_inset(o, thickness=0.012, depth=-0.004)

    final = normalize_tris(root, TRI_LO, TRI_HI)
    join_except(root, ("glow",), "MissileBody")
    print("MISSILE_TRIS_FINAL:", final, "meshes:", len(collect_meshes(root)))
    root.rotation_euler = (0, 0, math.radians(180))
    _save("missile", root)


# ---------------------------------------------------------------------------
def build_tree():
    reset_scene()
    m_trunk = mat("T_Trunk", 0x5a3a22, metallic=0.0, roughness=0.90)
    m_bark  = mat("T_Bark",  0x4a2e1c, metallic=0.0, roughness=0.95)
    m_leaf1 = mat("T_Leaf1", 0x2f7d32, metallic=0.0, roughness=0.95)
    m_leaf2 = mat("T_Leaf2", 0x3a8a3e, metallic=0.0, roughness=0.95)
    m_leaf3 = mat("T_Leaf3", 0x276b2b, metallic=0.0, roughness=0.95)

    root = group("Tree", (0, 0, 0))
    trunk_h = 1.7

    # Tapered trunk in stacked sections, each slightly offset for a natural lean
    y = 0.0
    for i in range(4):
        h = trunk_h / 4
        r0 = 0.30 - i * 0.05
        r1 = 0.30 - (i + 1) * 0.05
        seg = cylinder(f"Trunk_{i}", radius=r0, depth=h, vertices=14, radius2=r1,
                       location=(math.sin(i * 1.1) * 0.04, math.cos(i * 0.9) * 0.04, y + h / 2),
                       material=m_trunk if i % 2 == 0 else m_bark)
        seg.parent = root
        y += h

    # Root flare
    flare = cone("RootFlare", radius=0.44, depth=0.42, vertices=14,
                 location=(0, 0, 0.20), material=m_bark)
    flare.parent = root

    # Branches radiating out under each foliage layer
    for i in range(6):
        a = i * (TAU / 6) + 0.4
        h = 1.2 + (i % 3) * 0.5
        br = cylinder(f"Branch_{i}", radius=0.055, depth=0.75, vertices=8, radius2=0.025,
                      location=(math.cos(a) * 0.30, math.sin(a) * 0.30, h),
                      rotation=(math.radians(62) * math.sin(a),
                                math.radians(62) * math.cos(a), 0),
                      material=m_bark)
        br.parent = root

    # Layered canopy — subdivided cones read as needled tiers, not smooth ones
    mats = (m_leaf1, m_leaf2, m_leaf3)
    for i in range(5):
        r = 1.35 - i * 0.21
        layer = cone(f"Leaf_{i}", radius=r, depth=1.35, vertices=16,
                     location=(0, 0, trunk_h + 0.30 + i * 0.62), material=mats[i % 3])
        subdivide_mesh(layer, cuts=1)
        _jitter(layer, 0.05, seed=11 + i)
        layer.parent = root

    crown = ico("Crown", radius=0.42, subdivisions=2,
                location=(0, 0, trunk_h + 3.55), material=m_leaf1)
    _jitter(crown, 0.12, seed=5)
    crown.parent = root

    final = normalize_tris(root, TRI_LO, TRI_HI)
    print("TREE_TRIS_FINAL:", final)
    lods = build_lod_chain(root, "Tree", SCENERY_LODS)
    _flatten_lods(root, lods, "Tree")
    _save("tree", root, lods)


# ---------------------------------------------------------------------------
def build_rock():
    reset_scene()
    m_rock  = mat("R_Rock",  0x6b6f73, metallic=0.10, roughness=0.90)
    m_rock2 = mat("R_Rock2", 0x5c6165, metallic=0.10, roughness=0.92)
    m_moss  = mat("R_Moss",  0x4a6b3a, metallic=0.00, roughness=0.98)

    root = group("Rock", (0, 0, 0))
    rng = random.Random(7)

    # A few large masses...
    for i in range(3):
        r = rng.uniform(0.6, 1.15)
        boulder = ico(f"Rock_{i}", radius=r, subdivisions=3,
                      location=(rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6), r * 0.42),
                      material=m_rock if i % 2 == 0 else m_rock2)
        _jitter(boulder, 0.22, seed=31 + i * 7)
        boulder.scale = (1.0, 1.0, 0.62)
        apply_scale(boulder)
        boulder.parent = root

    # ...plus scree at the base so it sits in the terrain instead of on it
    for i in range(5):
        r = rng.uniform(0.14, 0.30)
        chip = ico(f"Scree_{i}", radius=r, subdivisions=2,
                   location=(rng.uniform(-1.1, 1.1), rng.uniform(-1.1, 1.1), r * 0.4),
                   material=m_rock2)
        _jitter(chip, 0.3, seed=71 + i * 3)
        chip.scale = (1.0, 1.0, 0.55)
        apply_scale(chip)
        chip.parent = root

    # Moss patch on the largest mass
    moss = ico("Moss", radius=0.5, subdivisions=2, location=(0.1, 0.1, 0.62), material=m_moss)
    _jitter(moss, 0.18, seed=99)
    moss.scale = (1.0, 1.0, 0.22)
    apply_scale(moss)
    moss.parent = root

    final = normalize_tris(root, TRI_LO, TRI_HI)
    print("ROCK_TRIS_FINAL:", final)
    lods = build_lod_chain(root, "Rock", SCENERY_LODS)
    _flatten_lods(root, lods, "Rock")
    _save("rock", root, lods)


# ---------------------------------------------------------------------------
def build_cloud():
    reset_scene()
    # Opaque. At alpha 0.92 the blending bought nothing visible but forced all
    # 70 clouds into the transparent pass, where they depth-sort against each
    # other and against the ocean — surfaces punching through one another.
    m_cloud = mat("C_Cloud", 0xffffff, metallic=0.0, roughness=1.0)
    m_shade = mat("C_Shade", 0xdfe6f0, metallic=0.0, roughness=1.0)

    root = group("Cloud", (0, 0, 0))
    rng = random.Random(123)

    # Big puffs up top catching light, flatter shaded ones underneath
    for i in range(6):
        r = rng.uniform(1.0, 2.3)
        puff = ico(f"Puff_{i}", radius=r, subdivisions=2,
                   location=(rng.uniform(-3.0, 3.0), rng.uniform(-2.4, 2.4),
                             rng.uniform(0.0, 0.9)),
                   material=m_cloud)
        _jitter(puff, 0.16, seed=201 + i * 5)
        puff.scale = (1.0, 1.0, 0.68)
        apply_scale(puff)
        puff.parent = root

    for i in range(4):
        r = rng.uniform(0.9, 1.7)
        base = ico(f"Base_{i}", radius=r, subdivisions=2,
                   location=(rng.uniform(-2.6, 2.6), rng.uniform(-2.0, 2.0),
                             rng.uniform(-0.8, -0.2)),
                   material=m_shade)
        _jitter(base, 0.14, seed=301 + i * 5)
        base.scale = (1.0, 1.0, 0.45)
        apply_scale(base)
        base.parent = root

    final = normalize_tris(root, TRI_LO, TRI_HI)
    print("CLOUD_TRIS_FINAL:", final)
    lods = build_lod_chain(root, "Cloud", SCENERY_LODS)
    _flatten_lods(root, lods, "Cloud")
    _save("cloud", root, lods)


if __name__ == "__main__":
    build_missile()
    build_tree()
    build_rock()
    build_cloud()
    print("PROPS_DONE")
