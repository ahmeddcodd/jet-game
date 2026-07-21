"""
build_helicopter.py — detailed gunship helicopter, built in Blender.
Output: blender/helicopter.blend, public/assets/models/helicopter.glb

Target: 10,000-11,000 triangles.

Runtime hooks: the game finds the Empties named "Rotor" and "TailRotor" and
spins them. Everything that should rotate must be parented under those, and
their names must survive the detail/normalize passes untouched.
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
    torus, group, empty, flat_shade, assign, save_blend, export_glb, TAU,
    panel_inset, bevel_edges, normalize_tris, total_tris, apply_scale,
    select_only, join_meshes, join_except, collect_meshes,
)

TRI_LO, TRI_HI = 10000, 11000


def build(palette=None):
    if palette is None:
        palette = {"body": 0x35553a, "body2": 0x24392a, "accent": 0xffcc44}
    reset_scene()

    m_body   = mat("H_Body",   palette["body"],   metallic=0.20, roughness=0.70)
    m_body2  = mat("H_Body2",  palette["body2"],  metallic=0.10, roughness=0.80)
    m_glass  = mat("H_Glass",  0x10241a, metallic=0.60, roughness=0.25, alpha=0.6)
    m_dark   = mat("H_Dark",   0x141a16, metallic=0.20, roughness=0.70)
    m_accent = mat("H_Accent", palette["accent"], metallic=0.20, roughness=0.50)
    m_metal  = mat("H_Metal",  0x222828, metallic=0.70, roughness=0.40)
    m_red    = mat("H_Red",    0xff4d4d, emission=hex_to_rgb(0xff0000), emission_strength=1.4)

    root = group("Helicopter", (0, 0, 0))
    detail_targets = []

    def part(obj, parent=root, panels=False):
        obj.parent = parent
        if panels:
            detail_targets.append(obj)
        return obj

    # ------------------------------------------------------------------
    # Fuselage
    # ------------------------------------------------------------------
    body = cylinder("Body", radius=0.95, depth=2.8, vertices=18,
                    location=(0, 0.15, 0), material=m_body)
    body.scale = (1.0, 1.25, 1.05)
    apply_scale(body)
    part(body, panels=True)

    belly = cylinder("BellyPod", radius=0.72, depth=2.2, vertices=16,
                     location=(0, 0.35, -0.62), material=m_body2)
    belly.scale = (1.05, 1.3, 0.6)
    apply_scale(belly)
    part(belly, panels=True)

    # Stepped tandem canopy — gunner low and forward, pilot raised behind
    glass_f = uv_sphere("GlassFront", radius=0.62, segments=16, rings=9,
                        location=(0, 1.62, 0.05), material=m_glass)
    glass_f.scale = (1.02, 1.25, 0.85)
    apply_scale(glass_f)
    part(glass_f)

    glass_r = uv_sphere("GlassRear", radius=0.62, segments=16, rings=9,
                        location=(0, 0.75, 0.38), material=m_glass)
    glass_r.scale = (1.0, 1.05, 0.80)
    apply_scale(glass_r)
    part(glass_r)

    for i, (fy, fz) in enumerate(((1.98, 0.10), (1.20, 0.28), (0.30, 0.52))):
        bow = torus(f"CanopyBow{i}", major_radius=0.60, minor_radius=0.045,
                    major_segments=14, minor_segments=6,
                    location=(0, fy, fz),
                    rotation=(math.radians(90), 0, 0), material=m_body2)
        part(bow)

    nose = cone("Nose", radius=0.55, depth=1.0, vertices=16,
                location=(0, 2.35, -0.10),
                rotation=(math.radians(-90), 0, 0), material=m_body)
    nose.scale = (1.05, 1.0, 0.82)
    apply_scale(nose)
    part(nose, panels=True)

    # ------------------------------------------------------------------
    # Tail boom + empennage
    # ------------------------------------------------------------------
    boom = cylinder("Boom", radius=0.30, depth=4.2, vertices=14, radius2=0.19,
                    location=(0, -2.45, 0.25),
                    rotation=(math.radians(90), 0, 0), material=m_body2)
    part(boom, panels=True)

    boom_root = cylinder("BoomRoot", radius=0.46, depth=0.9, vertices=14, radius2=0.32,
                         location=(0, -1.05, 0.22),
                         rotation=(math.radians(90), 0, 0), material=m_body)
    part(boom_root, panels=True)

    fin = _plate("TailFin", [
        (0, -3.95, 0), (0, -4.15, 1.25), (0, -4.75, 1.25), (0, -4.80, 0),
    ], 0.10, m_body2, axis=0)
    fin.location = (0, 0, 0.30)
    part(fin, panels=True)

    lower_fin = _plate("LowerFin", [
        (0, -4.10, 0), (0, -4.20, -0.70), (0, -4.75, -0.70), (0, -4.78, 0),
    ], 0.09, m_body2, axis=0)
    lower_fin.location = (0, 0, 0.20)
    part(lower_fin)

    for sx, tag in ((1, "L"), (-1, "R")):
        stab = _plate(f"Stab{tag}", [
            (0, -3.55, 0), (sx * 0.95, -3.65, 0), (sx * 0.95, -4.10, 0), (0, -4.15, 0),
        ], 0.08, m_body2)
        stab.location = (0, 0, 0.25)
        part(stab)

    # ------------------------------------------------------------------
    # Stub wings + weapon pylons
    # ------------------------------------------------------------------
    for sx, tag in ((1, "L"), (-1, "R")):
        stub = _plate(f"Stub{tag}", [
            (sx * 0.55, 0.72, 0), (sx * 1.85, 0.55, 0),
            (sx * 1.85, -0.05, 0), (sx * 0.55, -0.15, 0),
        ], 0.16, m_body2)
        stub.location = (0, 0, -0.18)
        part(stub, panels=True)

        # Rocket pod with visible tube mouths
        pod = cylinder(f"Pod{tag}", radius=0.24, depth=0.95, vertices=14,
                       location=(sx * 1.35, 0.30, -0.36),
                       rotation=(math.radians(90), 0, 0), material=m_dark)
        part(pod, panels=True)
        for k in range(7):
            a = k * (TAU / 7)
            tube = cylinder(f"Tube{tag}{k}", radius=0.055, depth=0.10, vertices=8,
                            location=(sx * 1.35 + math.cos(a) * 0.13,
                                      0.78,
                                      -0.36 + math.sin(a) * 0.13),
                            rotation=(math.radians(90), 0, 0), material=m_metal)
            part(tube)

        # Outboard ATGM rail
        rail = cube(f"Rail{tag}", size=(0.10, 0.70, 0.10),
                    location=(sx * 1.82, 0.25, -0.30), material=m_metal)
        part(rail)
        for k in range(2):
            msl = cylinder(f"Atgm{tag}{k}", radius=0.075, depth=0.85, vertices=10,
                           location=(sx * (1.72 + k * 0.20), 0.25, -0.42),
                           rotation=(math.radians(90), 0, 0), material=m_dark)
            part(msl)

        navlight = ico(f"Nav{tag}", radius=0.07, subdivisions=1,
                       location=(sx * 1.95, 0.30, -0.14), material=m_red)
        part(navlight)

    # ------------------------------------------------------------------
    # Chin turret + sensor ball
    # ------------------------------------------------------------------
    turret = uv_sphere("Turret", radius=0.26, segments=14, rings=8,
                       location=(0, 1.75, -0.62), material=m_dark)
    part(turret)
    for k in range(3):
        barrel = cylinder(f"Barrel{k}", radius=0.045, depth=0.85, vertices=8,
                          location=(math.cos(k * TAU / 3) * 0.05,
                                    2.20,
                                    -0.62 + math.sin(k * TAU / 3) * 0.05),
                          rotation=(math.radians(90), 0, 0), material=m_metal)
        part(barrel)

    sensor = uv_sphere("Sensor", radius=0.22, segments=14, rings=8,
                       location=(0, 2.30, 0.28), material=m_dark)
    sensor.scale = (1.0, 0.9, 1.0)
    apply_scale(sensor)
    part(sensor)

    # ------------------------------------------------------------------
    # Landing gear — skids, struts, cross tubes
    # ------------------------------------------------------------------
    for sx, tag in ((1, "L"), (-1, "R")):
        skid = cylinder(f"Skid{tag}", radius=0.06, depth=2.8, vertices=10,
                        location=(sx * 0.62, 0.15, -1.12),
                        rotation=(math.radians(90), 0, 0), material=m_metal)
        part(skid)
        curl = cylinder(f"SkidTip{tag}", radius=0.055, depth=0.45, vertices=10,
                        location=(sx * 0.62, 1.62, -1.02),
                        rotation=(math.radians(60), 0, 0), material=m_metal)
        part(curl)
        for k, sy in enumerate((0.85, -0.55)):
            strut = cylinder(f"Strut{tag}{k}", radius=0.05, depth=0.62, vertices=8,
                             location=(sx * 0.58, sy, -0.82),
                             rotation=(0, math.radians(6 * sx), 0), material=m_metal)
            part(strut)

    # ------------------------------------------------------------------
    # Main rotor — everything under the "Rotor" empty spins at runtime
    # ------------------------------------------------------------------
    rotor = empty("Rotor", (0, 0.15, 1.15))
    rotor.parent = root

    mast = cylinder("Mast", radius=0.10, depth=0.55, vertices=12,
                    location=(0, 0, 0.22), material=m_metal)
    part(mast, rotor)
    hub = cylinder("Hub", radius=0.24, depth=0.22, vertices=14,
                   location=(0, 0, 0), material=m_metal)
    part(hub, rotor)
    swash = cylinder("Swash", radius=0.30, depth=0.08, vertices=14,
                     location=(0, 0, -0.16), material=m_dark)
    part(swash, rotor)

    for i in range(4):
        a = i * (TAU / 4)
        blade = cube(f"Blade{i}", size=(0.20, 6.6, 0.045), location=(0, 0, 0), material=m_dark)
        blade.rotation_euler = (0, 0, a)
        part(blade, rotor)

        tip = cube(f"BladeTip{i}", size=(0.20, 0.55, 0.05),
                   location=(math.cos(a + math.pi / 2) * 3.05,
                             math.sin(a + math.pi / 2) * 3.05, 0.005),
                   material=m_accent)
        tip.rotation_euler = (0, 0, a)
        part(tip, rotor)

        # Pitch link from swashplate to each blade root
        link = cylinder(f"PitchLink{i}", radius=0.022, depth=0.30, vertices=6,
                        location=(math.cos(a + math.pi / 2) * 0.26,
                                  math.sin(a + math.pi / 2) * 0.26, -0.10),
                        material=m_metal)
        part(link, rotor)

    # ------------------------------------------------------------------
    # Tail rotor — spins under the "TailRotor" empty
    # ------------------------------------------------------------------
    tail_rotor = empty("TailRotor", (0.22, -4.45, 0.85))
    tail_rotor.parent = root

    thub = cylinder("TailHub", radius=0.10, depth=0.12, vertices=10,
                    location=(0, 0, 0), rotation=(0, math.radians(90), 0), material=m_metal)
    part(thub, tail_rotor)
    for i in range(4):
        a = i * (TAU / 4)
        tb = cube(f"TBlade{i}", size=(0.07, 1.05, 0.10), location=(0, 0, 0), material=m_dark)
        tb.rotation_euler = (a, math.radians(90), 0)
        part(tb, tail_rotor)

    # ------------------------------------------------------------------
    # Details
    # ------------------------------------------------------------------
    exhaust_l = cylinder("ExhaustL", radius=0.20, depth=0.60, vertices=12,
                         location=(0.55, -0.55, 0.62),
                         rotation=(math.radians(80), 0, math.radians(18)), material=m_dark)
    part(exhaust_l)
    exhaust_r = cylinder("ExhaustR", radius=0.20, depth=0.60, vertices=12,
                         location=(-0.55, -0.55, 0.62),
                         rotation=(math.radians(80), 0, math.radians(-18)), material=m_dark)
    part(exhaust_r)

    engine_deck = cube("EngineDeck", size=(1.30, 1.70, 0.42),
                       location=(0, -0.35, 0.68), material=m_body2)
    part(engine_deck, panels=True)

    intake_l = cylinder("EngIntakeL", radius=0.17, depth=0.30, vertices=12,
                        location=(0.42, 0.52, 0.72),
                        rotation=(math.radians(90), 0, 0), material=m_dark)
    part(intake_l)
    intake_r = cylinder("EngIntakeR", radius=0.17, depth=0.30, vertices=12,
                        location=(-0.42, 0.52, 0.72),
                        rotation=(math.radians(90), 0, 0), material=m_dark)
    part(intake_r)

    for i, sy in enumerate((0.95, -0.25, -1.45)):
        step = cube(f"Step{i}", size=(0.16, 0.30, 0.06), location=(0.92, sy, -0.42), material=m_dark)
        part(step)

    # ------------------------------------------------------------------
    for obj in detail_targets:
        panel_inset(obj, thickness=0.030, depth=-0.012)
    bevel_edges(body, width=0.022, segments=2)

    print("HELO_TRIS_PRE_NORMALIZE:", total_tris(root))
    final = normalize_tris(root, TRI_LO, TRI_HI)

    # Each spinning assembly collapses to a single mesh under its empty, so the
    # rotors still animate as units while costing one draw call apiece.
    join_meshes(collect_meshes(rotor), "RotorMesh")
    join_meshes(collect_meshes(tail_rotor), "TailRotorMesh")
    join_except(root, ("rotor", "nav"), "Airframe")
    print("HELO_TRIS_FINAL:", total_tris(root), "meshes:", len(collect_meshes(root)))

    root.rotation_euler = (0, 0, math.radians(180))
    return root, final


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
    blend_path = os.path.join(HERE, "helicopter.blend")
    glb_path = os.path.join(HERE, "..", "public", "assets", "models", "helicopter.glb")
    os.makedirs(os.path.dirname(glb_path), exist_ok=True)
    save_blend(blend_path)
    print("HELO_BLEND_SAVED:", os.path.exists(blend_path))
    export_glb(glb_path)
    print("HELO_GLB_SAVED:", os.path.exists(glb_path),
          os.path.getsize(glb_path) if os.path.exists(glb_path) else 0)
    print("HELO_DONE")
