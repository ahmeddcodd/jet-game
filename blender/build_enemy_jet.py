"""
build_enemy_jet.py — detailed enemy interceptor, built in Blender.
Output: blender/enemy_jet.blend, public/assets/models/enemy_jet.glb

Target: 40,000-41,000 triangles.

Deliberately a different airframe language from the player: broad shoulders,
variable-geometry look, chunky twin exhausts, heavier ordnance. Silhouette
readability matters more than realism here — the player must identify a threat
at a glance, from any angle, at distance.

Runtime hooks: Glow*, Nav*.
"""
import bpy
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from bpy_helpers import (
    reset_scene, mat, hex_to_rgb, cone, cylinder, cube, ico, uv_sphere,
    torus, group, flat_shade, assign, save_blend, export_glb, TAU,
    panel_inset, detail_pass, bevel_edges, normalize_tris, total_tris, apply_scale,
    select_only, join_except, collect_meshes,
)

TRI_LO, TRI_HI = 40000, 41000


def build(palette=None):
    if palette is None:
        palette = {"body": 0x6e2222, "body2": 0x4a1818, "accent": 0xffaa33}
    reset_scene()

    m_body   = mat("E_Body",   palette["body"],   metallic=0.30, roughness=0.60)
    m_body2  = mat("E_Body2",  palette["body2"],  metallic=0.10, roughness=0.80)
    m_canopy = mat("E_Canopy", 0x140a0a, metallic=0.70, roughness=0.20, alpha=0.55)
    m_accent = mat("E_Accent", palette["accent"], metallic=0.20, roughness=0.50)
    m_dark   = mat("E_Dark",   0x180c0c, metallic=0.20, roughness=0.70)
    m_steel  = mat("E_Steel",  0x7a7070, metallic=0.90, roughness=0.40)
    m_red    = mat("E_Red",    0xff4d4d, emission=hex_to_rgb(0xff0000), emission_strength=1.5)
    m_glow   = mat("E_Glow",   0xff5522, emission=hex_to_rgb(0xff5522), emission_strength=2.0)

    root = group("EnemyJet", (0, 0, 0))
    detail_targets = []

    def part(obj, parent=root, panels=False):
        obj.parent = parent
        if panels:
            detail_targets.append(obj)
        return obj

    # ------------------------------------------------------------------
    # Fuselage — broad, slab-sided
    # ------------------------------------------------------------------
    nose = cone("Nose", radius=0.46, depth=1.9, vertices=18,
                location=(0, 3.35, -0.02),
                rotation=(math.radians(-90), 0, 0), material=m_dark)
    nose.scale = (1.15, 1.0, 0.85)
    apply_scale(nose)
    part(nose)

    fwd = cylinder("FuseFwd", radius=0.66, depth=2.4, vertices=18, radius2=0.48,
                   location=(0, 1.35, 0),
                   rotation=(math.radians(90), 0, 0), material=m_body)
    fwd.scale = (1.25, 1.0, 0.78)
    apply_scale(fwd)
    part(fwd, panels=True)

    mid = cylinder("FuseMid", radius=0.86, depth=2.8, vertices=18,
                   location=(0, -0.55, -0.02),
                   rotation=(math.radians(90), 0, 0), material=m_body)
    mid.scale = (1.35, 1.0, 0.70)
    apply_scale(mid)
    part(mid, panels=True)

    aft = cylinder("FuseAft", radius=0.82, depth=2.2, vertices=18, radius2=0.66,
                   location=(0, -2.85, -0.04),
                   rotation=(math.radians(-90), 0, 0), material=m_body2)
    aft.scale = (1.40, 1.0, 0.70)
    apply_scale(aft)
    part(aft, panels=True)

    # Shoulder blisters — the "brutish" read
    for sx, tag in ((1, "L"), (-1, "R")):
        blister = uv_sphere(f"Blister{tag}", radius=0.42, segments=14, rings=8,
                            location=(sx * 0.86, 0.25, 0.12), material=m_body2)
        blister.scale = (0.75, 2.2, 0.62)
        apply_scale(blister)
        part(blister, panels=True)

    # ------------------------------------------------------------------
    # Cockpit
    # ------------------------------------------------------------------
    canopy = uv_sphere("Canopy", radius=0.46, segments=16, rings=9,
                       location=(0, 1.20, 0.32), material=m_canopy)
    canopy.scale = (0.95, 1.70, 0.72)
    apply_scale(canopy)
    part(canopy)

    frame = torus("CanopyFrame", major_radius=0.40, minor_radius=0.05,
                  major_segments=16, minor_segments=6,
                  location=(0, 0.48, 0.24),
                  rotation=(math.radians(90), 0, 0), material=m_accent)
    apply_scale(frame)
    part(frame)

    seat = cube("Seat", size=(0.32, 0.34, 0.42), location=(0, 1.00, 0.14), material=m_dark)
    part(seat)

    # ------------------------------------------------------------------
    # Intakes — big rectangular boxes, very readable head-on
    # ------------------------------------------------------------------
    for sx, tag in ((1, "L"), (-1, "R")):
        intake = cube(f"Intake{tag}", size=(0.46, 1.9, 0.60),
                      location=(sx * 0.98, 0.85, -0.24), material=m_body2)
        part(intake, panels=True)
        mouth = cube(f"IntakeMouth{tag}", size=(0.36, 0.10, 0.48),
                     location=(sx * 0.98, 1.82, -0.24), material=m_dark)
        part(mouth)
        ramp = cube(f"Ramp{tag}", size=(0.06, 1.30, 0.52),
                    location=(sx * 0.72, 1.05, -0.22), material=m_dark)
        part(ramp)

    # ------------------------------------------------------------------
    # Wings — swept, with control surfaces, pylons, heavy ordnance
    # ------------------------------------------------------------------
    for sx, tag in ((1, "L"), (-1, "R")):
        wing = _swept_wing(f"Wing{tag}", m_body2, sx)
        part(wing, panels=True)

        glove = _plate(f"Glove{tag}", [
            (sx * 0.55, 1.85, 0), (sx * 1.45, 0.55, 0),
            (sx * 1.45, -0.25, 0), (sx * 0.55, 0.30, 0),
        ], 0.11, m_body2)
        part(glove, panels=True)

        flap = cube(f"Flap{tag}", size=(1.45, 0.50, 0.09),
                    location=(sx * 1.75, -1.85, -0.04), material=m_body)
        flap.rotation_euler = (0, 0, math.radians(-12 * sx))
        part(flap, panels=True)

        # Trim stripe for at-a-glance faction colour
        trim = cube(f"Trim{tag}", size=(1.70, 0.18, 0.05),
                    location=(sx * 1.75, -0.75, 0.06), material=m_accent)
        trim.rotation_euler = (0, 0, math.radians(22 * sx))
        part(trim)

        # Two pylons per wing, each with a bomb/missile
        for i, (px, py) in enumerate(((1.35, -0.35), (2.35, -0.75))):
            pylon = cube(f"Pylon{tag}{i}", size=(0.13, 0.62, 0.28),
                         location=(sx * px, py, -0.24), material=m_dark)
            part(pylon)
            ordn = cylinder(f"Ord{tag}{i}", radius=0.13, depth=1.5, vertices=12,
                            location=(sx * px, py + 0.15, -0.46),
                            rotation=(math.radians(90), 0, 0), material=m_steel)
            part(ordn)
            onose = cone(f"OrdNose{tag}{i}", radius=0.13, depth=0.40, vertices=12,
                         location=(sx * px, py + 1.09, -0.46),
                         rotation=(math.radians(-90), 0, 0), material=m_dark)
            part(onose)
            for k in range(4):
                a = k * (TAU / 4) + math.radians(45)
                f = cube(f"OrdFin{tag}{i}{k}", size=(0.03, 0.30, 0.20),
                         location=(sx * px + math.cos(a) * 0.16,
                                   py - 0.52,
                                   -0.46 + math.sin(a) * 0.16), material=m_dark)
                f.rotation_euler = (a, 0, 0)
                part(f)

        navlight = ico(f"Nav{tag}", radius=0.09, subdivisions=1,
                       location=(sx * 3.85, -1.15, 0.0), material=m_red)
        part(navlight)

    # ------------------------------------------------------------------
    # Tail — twin canted fins + stabilators + ventral strakes
    # ------------------------------------------------------------------
    for sx, tag in ((1, "L"), (-1, "R")):
        fin = _plate(f"Fin{tag}", [
            (0, -1.95, 0), (0, -2.15, 1.55), (0, -3.15, 1.55), (0, -3.25, 0),
        ], 0.11, m_body2, axis=0)
        fin.location = (sx * 0.72, 0, 0.32)
        fin.rotation_euler = (0, math.radians(-13 * sx), 0)
        part(fin, panels=True)

        rudder = cube(f"Rudder{tag}", size=(0.07, 0.40, 1.15),
                      location=(sx * 0.90, -3.22, 1.10), material=m_body)
        rudder.rotation_euler = (0, math.radians(-13 * sx), 0)
        part(rudder, panels=True)

        stab = _plate(f"Stab{tag}", [
            (sx * 0.45, -2.55, 0), (sx * 1.85, -3.05, 0),
            (sx * 1.85, -3.55, 0), (sx * 0.45, -3.45, 0),
        ], 0.09, m_body)
        stab.location = (0, 0, -0.12)
        part(stab, panels=True)

        strake = _plate(f"Strake{tag}", [
            (0, -2.35, 0), (0, -2.55, -0.85), (0, -3.35, -0.85), (0, -3.35, 0),
        ], 0.08, m_dark, axis=0)
        strake.location = (sx * 0.55, 0, -0.30)
        part(strake)

    # ------------------------------------------------------------------
    # Engines — twin cans with petals and glow
    # ------------------------------------------------------------------
    for sx, tag in ((1, "L"), (-1, "R")):
        can = cylinder(f"Exhaust{tag}", radius=0.40, depth=1.5, vertices=16,
                       location=(sx * 0.58, -3.25, -0.06),
                       rotation=(math.radians(90), 0, 0), material=m_dark)
        part(can, panels=True)

        noz = cylinder(f"Nozzle{tag}", radius=0.40, depth=0.55, vertices=16, radius2=0.29,
                       location=(sx * 0.58, -4.15, -0.06),
                       rotation=(math.radians(-90), 0, 0), material=m_steel)
        part(noz)

        for i in range(12):
            a = i * (TAU / 12)
            petal = cube(f"Petal{tag}{i}", size=(0.09, 0.32, 0.05),
                         location=(sx * 0.58 + math.cos(a) * 0.33,
                                   -4.24,
                                   -0.06 + math.sin(a) * 0.33), material=m_steel)
            petal.rotation_euler.rotate_axis('Y', a)
            part(petal)

        glow = cylinder(f"Glow{tag}", radius=0.26, depth=0.06, vertices=16,
                        location=(sx * 0.58, -4.38, -0.06),
                        rotation=(math.radians(90), 0, 0), material=m_glow)
        part(glow)

    # ------------------------------------------------------------------
    # Details
    # ------------------------------------------------------------------
    spine = cube("Spine", size=(0.40, 4.0, 0.30), location=(0, -0.85, 0.46), material=m_body2)
    part(spine, panels=True)

    probe = cylinder("Probe", radius=0.03, depth=0.9, vertices=8,
                     location=(0, 4.55, -0.02),
                     rotation=(math.radians(90), 0, 0), material=m_steel)
    part(probe)

    for i, y in enumerate((1.55, -0.25, -1.85)):
        ant = cube(f"BladeAnt{i}", size=(0.05, 0.24, 0.18), location=(0, y, -0.50), material=m_dark)
        part(ant)

    belly = cube("Belly", size=(1.50, 3.40, 0.22), location=(0, -0.70, -0.46), material=m_dark)
    part(belly, panels=True)

    # ------------------------------------------------------------------
    for obj in detail_targets:
        detail_pass(obj, micro=0.006)
    bevel_edges(mid, width=0.022, segments=2)
    bevel_edges(fwd, width=0.022, segments=2)

    print("ENEMY_TRIS_PRE_NORMALIZE:", total_tris(root))
    final = normalize_tris(root, TRI_LO, TRI_HI)

    join_except(root, ("glow", "nav"), "Airframe")
    print("ENEMY_TRIS_FINAL:", total_tris(root), "meshes:", len(collect_meshes(root)))

    root.rotation_euler = (0, 0, math.radians(180))
    return root, final


def _swept_wing(name, material, sx):
    verts = [
        (0.55 * sx, 0.55, 0),
        (3.85 * sx, -0.95, 0),
        (3.85 * sx, -1.55, 0),
        (0.90 * sx, -2.15, 0),
        (0.55 * sx, -0.70, 0),
    ]
    return _plate(name, verts, 0.13, material)


def _plate(name, verts, thickness, material, axis=2):
    mesh = bpy.data.meshes.new(name + "_mesh")
    mesh.from_pydata(verts, [], [tuple(range(len(verts)))])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    select_only(obj)
    offset = [0.0, 0.0, 0.0]
    offset[axis] = thickness
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.extrude_region_move(TRANSFORM_OT_translate={"value": tuple(offset)})
    bpy.ops.object.mode_set(mode='OBJECT')
    flat_shade(obj)
    assign(obj, material)
    return obj


if __name__ == "__main__":
    root, tris = build()
    blend_path = os.path.join(HERE, "enemy_jet.blend")
    glb_path = os.path.join(HERE, "..", "public", "assets", "models", "enemy_jet.glb")
    os.makedirs(os.path.dirname(glb_path), exist_ok=True)
    save_blend(blend_path)
    print("ENEMY_BLEND_SAVED:", os.path.exists(blend_path))
    export_glb(glb_path)
    print("ENEMY_GLB_SAVED:", os.path.exists(glb_path),
          os.path.getsize(glb_path) if os.path.exists(glb_path) else 0)
    print("ENEMY_DONE")
