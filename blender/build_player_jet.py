"""
build_player_jet.py — detailed player fighter, built in Blender.
Output: blender/player_jet.blend, public/assets/models/player_jet.glb

Target: 40,000-41,000 triangles.

The detail is *structural*, not subdivision: separate control surfaces, intake
ducts, nozzle petals, cockpit interior, pylons and ordnance, antennae — then a
panel-inset pass that recesses every large face so the key light picks out
plating. Only after that do we collapse into the triangle window, because
decimating detailed geometry keeps character that subdividing simple geometry
never creates.

Convention: built nose toward +Y, root rotated 180° on Z so the game (after
export_yup) sees forward = +Z, up = +Y.

Runtime hooks the game looks up by name: Flame*, Glow*, Nav*.
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


def build():
    reset_scene()

    # ---- Materials ----
    m_body   = mat("P_Body",   0x394554, metallic=0.35, roughness=0.55)
    m_body2  = mat("P_Body2",  0x2b3540, metallic=0.10, roughness=0.80)
    m_canopy = mat("P_Canopy", 0x0a1a22, metallic=0.60, roughness=0.25, alpha=0.55)
    m_accent = mat("P_Accent", 0x12c4a8, metallic=0.20, roughness=0.50)
    m_dark   = mat("P_Dark",   0x141a20, metallic=0.20, roughness=0.70)
    m_steel  = mat("P_Steel",  0x8a949e, metallic=0.90, roughness=0.35)
    m_red    = mat("P_Red",    0xff4d4d, emission=hex_to_rgb(0xff0000), emission_strength=1.5)
    m_green  = mat("P_Green",  0x30ff30, emission=hex_to_rgb(0x00ff00), emission_strength=1.5)
    m_glow   = mat("P_Glow",   0x66ccff, emission=hex_to_rgb(0x66ccff), emission_strength=2.0)

    root = group("PlayerJet", (0, 0, 0))
    detail_targets = []   # large surfaces that get the panel-line pass

    def part(obj, parent=root, panels=False):
        obj.parent = parent
        if panels:
            detail_targets.append(obj)
        return obj

    # ------------------------------------------------------------------
    # Forward fuselage + radome
    # ------------------------------------------------------------------
    radome = cone("Radome", radius=0.42, depth=2.2, vertices=20,
                  location=(0, 4.15, -0.02),
                  rotation=(math.radians(-90), 0, 0), material=m_dark)
    radome.scale = (1.0, 1.0, 0.82)
    apply_scale(radome)
    part(radome)

    fwd = cylinder("FuseFwd", radius=0.62, depth=2.6, vertices=20, radius2=0.44,
                   location=(0, 2.0, 0),
                   rotation=(math.radians(90), 0, 0), material=m_body)
    fwd.scale = (1.0, 1.0, 0.80)
    apply_scale(fwd)
    part(fwd, panels=True)

    mid = cylinder("FuseMid", radius=0.72, depth=3.0, vertices=20,
                   location=(0, -0.2, -0.02),
                   rotation=(math.radians(90), 0, 0), material=m_body)
    mid.scale = (1.15, 1.0, 0.72)
    apply_scale(mid)
    part(mid, panels=True)

    aft = cylinder("FuseAft", radius=0.70, depth=2.6, vertices=20, radius2=0.52,
                   location=(0, -2.7, -0.04),
                   rotation=(math.radians(-90), 0, 0), material=m_body2)
    aft.scale = (1.20, 1.0, 0.70)
    apply_scale(aft)
    part(aft, panels=True)

    # Spine / dorsal fairing running the length of the back
    spine = cube("Spine", size=(0.34, 4.6, 0.26), location=(0, -0.6, 0.44), material=m_body2)
    part(spine, panels=True)

    # ------------------------------------------------------------------
    # Cockpit — canopy, frame, and an interior you can actually see
    # ------------------------------------------------------------------
    canopy = uv_sphere("Canopy", radius=0.5, segments=18, rings=10,
                       location=(0, 1.55, 0.34), material=m_canopy)
    canopy.scale = (0.86, 1.75, 0.72)
    apply_scale(canopy)
    part(canopy)

    frame = torus("CanopyFrame", major_radius=0.42, minor_radius=0.045,
                  major_segments=18, minor_segments=6,
                  location=(0, 0.72, 0.26),
                  rotation=(math.radians(90), 0, 0), material=m_accent)
    frame.scale = (1.05, 1.0, 1.25)
    apply_scale(frame)
    part(frame)

    # Interior: seat, headrest, instrument coaming
    seat = cube("Seat", size=(0.34, 0.36, 0.44), location=(0, 1.30, 0.16), material=m_dark)
    part(seat)
    headrest = cube("Headrest", size=(0.30, 0.16, 0.24), location=(0, 1.12, 0.40), material=m_dark)
    part(headrest)
    coaming = cube("Coaming", size=(0.44, 0.30, 0.16), location=(0, 2.02, 0.26), material=m_dark)
    part(coaming)

    # HUD glass in front of the pilot
    hud = cube("HudGlass", size=(0.26, 0.03, 0.20), location=(0, 1.86, 0.42), material=m_glow)
    part(hud)

    # ------------------------------------------------------------------
    # Intakes — lip ring + duct, one per side
    # ------------------------------------------------------------------
    for sx, tag in ((1, "L"), (-1, "R")):
        lip = torus(f"IntakeLip{tag}", major_radius=0.30, minor_radius=0.06,
                    major_segments=16, minor_segments=6,
                    location=(sx * 0.86, 1.05, -0.22),
                    rotation=(math.radians(90), 0, 0), material=m_steel)
        lip.scale = (1.0, 1.0, 1.25)
        apply_scale(lip)
        part(lip)

        duct = cylinder(f"IntakeDuct{tag}", radius=0.30, depth=2.4, vertices=16,
                        location=(sx * 0.86, -0.05, -0.22),
                        rotation=(math.radians(90), 0, 0), material=m_body2)
        duct.scale = (1.0, 1.0, 1.25)
        apply_scale(duct)
        part(duct, panels=True)

        # Boundary-layer splitter plate between duct and fuselage
        split = cube(f"Splitter{tag}", size=(0.05, 1.6, 0.42),
                     location=(sx * 0.60, 0.75, -0.20), material=m_dark)
        part(split)

    # ------------------------------------------------------------------
    # Wings — LERX, main delta, separate control surfaces, pylons, ordnance
    # ------------------------------------------------------------------
    for sx, tag in ((1, "L"), (-1, "R")):
        lerx = _wedge(f"Lerx{tag}", m_body2,
                      span=1.15 * sx, root_y=2.30, tip_y=0.55, chord=1.15, thick=0.10)
        part(lerx, panels=True)

        wing = _wing(f"Wing{tag}", m_body2, sx)
        part(wing, panels=True)

        # Trailing-edge control surfaces, inset slightly so a gap line reads
        flap = cube(f"Flap{tag}", size=(1.55, 0.52, 0.09),
                    location=(sx * 1.55, -1.62, -0.04), material=m_body)
        flap.rotation_euler = (0, 0, math.radians(-9 * sx))
        part(flap, panels=True)

        aileron = cube(f"Aileron{tag}", size=(1.25, 0.40, 0.07),
                       location=(sx * 3.15, -1.18, -0.04), material=m_body)
        aileron.rotation_euler = (0, 0, math.radians(-14 * sx))
        part(aileron, panels=True)

        # Underwing pylon + missile
        pylon = cube(f"Pylon{tag}", size=(0.12, 0.70, 0.26),
                     location=(sx * 2.35, -0.55, -0.24), material=m_dark)
        part(pylon)

        msl_body = cylinder(f"Ord{tag}", radius=0.10, depth=1.7, vertices=12,
                            location=(sx * 2.35, -0.35, -0.44),
                            rotation=(math.radians(90), 0, 0), material=m_steel)
        part(msl_body)
        msl_nose = cone(f"OrdNose{tag}", radius=0.10, depth=0.42, vertices=12,
                        location=(sx * 2.35, 0.71, -0.44),
                        rotation=(math.radians(-90), 0, 0), material=m_dark)
        part(msl_nose)
        for i in range(4):
            a = i * (TAU / 4) + math.radians(45)
            fin = cube(f"OrdFin{tag}{i}", size=(0.03, 0.34, 0.22),
                       location=(sx * 2.35 + math.cos(a) * 0.13,
                                 -1.02,
                                 -0.44 + math.sin(a) * 0.13),
                       material=m_dark)
            fin.rotation_euler = (a, 0, 0)
            part(fin)

        # Wingtip nav light  (name must contain "nav" for the runtime hook)
        navlight = ico(f"Nav{tag}", radius=0.085, subdivisions=1,
                       location=(sx * 4.30, -0.62, 0.0),
                       material=(m_red if sx > 0 else m_green))
        part(navlight)

        # Wing fence / vortex generator row
        for i in range(3):
            vg = cube(f"Vg{tag}{i}", size=(0.03, 0.16, 0.10),
                      location=(sx * (1.6 + i * 0.55), -0.15 - i * 0.12, 0.07),
                      material=m_dark)
            part(vg)

    # ------------------------------------------------------------------
    # Tail — canted fins with separate rudders, plus stabilators
    # ------------------------------------------------------------------
    for sx, tag in ((1, "L"), (-1, "R")):
        fin = _wedge(f"Fin{tag}", m_body2,
                     span=1.55, root_y=-2.25, tip_y=-3.35, chord=1.30, thick=0.10,
                     vertical=True)
        fin.location = (sx * 0.62, 0, 0.30)
        fin.rotation_euler = (0, math.radians(-16 * sx), 0)
        part(fin, panels=True)

        rudder = cube(f"Rudder{tag}", size=(0.07, 0.44, 1.05),
                      location=(sx * 0.80, -3.42, 1.02), material=m_body)
        rudder.rotation_euler = (0, math.radians(-16 * sx), 0)
        part(rudder, panels=True)

        stab = _wedge(f"Stab{tag}", m_body,
                      span=1.55 * sx, root_y=-2.75, tip_y=-3.55, chord=1.05, thick=0.09)
        stab.location = (sx * 0.55, 0, -0.10)
        part(stab, panels=True)

    # ------------------------------------------------------------------
    # Engines — nacelle, nozzle petals, glow disc, afterburner flame
    # ------------------------------------------------------------------
    for sx, tag in ((1, "L"), (-1, "R")):
        nac = cylinder(f"Nacelle{tag}", radius=0.34, depth=2.0, vertices=18,
                       location=(sx * 0.52, -3.05, -0.10),
                       rotation=(math.radians(90), 0, 0), material=m_dark)
        part(nac, panels=True)

        # Convergent nozzle ring
        noz = cylinder(f"Nozzle{tag}", radius=0.34, depth=0.55, vertices=18, radius2=0.24,
                       location=(sx * 0.52, -4.20, -0.10),
                       rotation=(math.radians(-90), 0, 0), material=m_steel)
        part(noz)

        # Petal detail around the nozzle lip — reads as a real engine can
        for i in range(14):
            a = i * (TAU / 14)
            petal = cube(f"Petal{tag}{i}", size=(0.07, 0.34, 0.05),
                         location=(sx * 0.52 + math.cos(a) * 0.28,
                                   -4.30,
                                   -0.10 + math.sin(a) * 0.28),
                         material=m_steel)
            petal.rotation_euler = (0, 0, 0)
            petal.rotation_euler.rotate_axis('Y', a)
            part(petal)

        glow = cylinder(f"Glow{tag}", radius=0.21, depth=0.06, vertices=16,
                        location=(sx * 0.52, -4.44, -0.10),
                        rotation=(math.radians(90), 0, 0), material=m_glow)
        part(glow)

        flame = cone(f"Flame{tag}", radius=0.20, depth=1.5, vertices=12,
                     location=(sx * 0.52, -5.30, -0.10),
                     rotation=(math.radians(90), 0, 0), material=m_glow)
        part(flame)

    # ------------------------------------------------------------------
    # Small hard-surface details
    # ------------------------------------------------------------------
    pitot = cylinder("Pitot", radius=0.025, depth=0.85, vertices=8,
                     location=(0, 5.55, -0.02),
                     rotation=(math.radians(90), 0, 0), material=m_steel)
    part(pitot)

    ant = cube("AntennaDorsal", size=(0.05, 0.34, 0.40), location=(0, -1.55, 0.66), material=m_dark)
    part(ant)

    for i, y in enumerate((0.55, -0.85, -2.05)):
        blade = cube(f"BladeAnt{i}", size=(0.04, 0.22, 0.16), location=(0, y, -0.52), material=m_dark)
        part(blade)

    belly = cube("Belly", size=(1.30, 3.60, 0.20), location=(0, -0.40, -0.44), material=m_dark)
    part(belly, panels=True)

    # Gear-bay doors, closed — pure panel-line storytelling
    for sx, tag in ((1, "L"), (-1, "R")):
        door = cube(f"GearDoor{tag}", size=(0.36, 1.10, 0.05),
                    location=(sx * 0.55, -0.30, -0.55), material=m_body2)
        part(door, panels=True)
    nose_door = cube("GearDoorN", size=(0.30, 0.90, 0.05), location=(0, 2.05, -0.44), material=m_body2)
    part(nose_door, panels=True)

    # ------------------------------------------------------------------
    # Detail pass, then land inside the triangle window
    # ------------------------------------------------------------------
    for obj in detail_targets:
        detail_pass(obj, micro=0.006)
    bevel_edges(mid, width=0.02, segments=2)
    bevel_edges(fwd, width=0.02, segments=2)

    print("PLAYER_TRIS_PRE_NORMALIZE:", total_tris(root))
    final = normalize_tris(root, TRI_LO, TRI_HI)

    # Collapse the airframe into one multi-material mesh, leaving the parts the
    # game animates by name (afterburner flames, engine glows, nav lights) as
    # independent objects.
    join_except(root, ("flame", "glow", "nav"), "Airframe")
    print("PLAYER_TRIS_FINAL:", total_tris(root), "meshes:", len(collect_meshes(root)))

    root.rotation_euler = (0, 0, math.radians(180))
    return root, final


def _wing(name, material, sx):
    """Main delta wing: a swept planform extruded to thickness."""
    s = 4.30 * sx
    verts = [
        (0.55 * sx, 1.05, 0),
        (s, -0.62, 0),
        (s, -1.30, 0),
        (0.85 * sx, -2.05, 0),
        (0.55 * sx, -0.60, 0),
    ]
    return _extrude_plate(name, verts, 0.14, material)


def _wedge(name, material, span, root_y, tip_y, chord, thick, vertical=False):
    """A tapered plate — used for LERX, fins and stabilators."""
    if vertical:
        verts = [
            (0, root_y, 0),
            (0, root_y - 0.15, span),
            (0, tip_y + 0.30, span),
            (0, tip_y, 0),
        ]
        # Vertical surfaces extrude along X
        return _extrude_plate(name, verts, thick, material, axis=0)
    verts = [
        (0, root_y, 0),
        (span, root_y - chord * 0.35, 0),
        (span, root_y - chord * 0.80, 0),
        (0, tip_y - chord * 0.10, 0),
    ]
    return _extrude_plate(name, verts, thick, material)


def _extrude_plate(name, verts, thickness, material, axis=2):
    """Build a flat n-gon and extrude it along `axis` to give it thickness."""
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
    blend_path = os.path.join(HERE, "player_jet.blend")
    glb_path = os.path.join(HERE, "..", "public", "assets", "models", "player_jet.glb")
    os.makedirs(os.path.dirname(glb_path), exist_ok=True)
    save_blend(blend_path)
    print("PLAYER_BLEND_SAVED:", os.path.exists(blend_path))
    export_glb(glb_path)
    print("PLAYER_GLB_SAVED:", os.path.exists(glb_path),
          os.path.getsize(glb_path) if os.path.exists(glb_path) else 0)
    print("PLAYER_DONE")
