"""
bpy_helpers.py — shared helpers for building low-poly assets in Blender.
Imported by every asset script. Provides material creation, flat-shading,
primitive wrappers that match the Three.js geometry we used before.
"""
import bpy
import math
from mathutils import Vector, Matrix

TAU = math.tau


def reset_scene():
    """Start from a clean factory scene."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, color, metallic=0.1, roughness=0.85,
                  emission=None, emission_strength=1.0, alpha=1.0):
    """Principled BSDF material with flat look. Color is (r,g,b) 0..1."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (color[0], color[1], color[2], alpha)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (emission[0], emission[1], emission[2], 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if alpha < 1.0:
        mat.blend_method = 'BLEND'
    return mat


def hex_to_rgb(h):
    """#RRGGBB or 0xRRGGBB integer -> (r,g,b) floats 0..1."""
    if isinstance(h, str):
        h = h.lstrip('#')
        r = int(h[0:2], 16); g = int(h[2:4], 16); b = int(h[4:6], 16)
    else:
        r = (h >> 16) & 255; g = (h >> 8) & 255; b = h & 255
    return (r / 255.0, g / 255.0, b / 255.0)


def mat(name, hex_color, **kw):
    """Convenience: create a material from a hex color."""
    return make_material(name, hex_to_rgb(hex_color), **kw)


def flat_shade(obj):
    """Mark all polygons of a mesh object as flat (not smooth)."""
    if obj.type == 'MESH':
        for p in obj.data.polygons:
            p.use_smooth = False
    return obj


def assign(obj, material):
    """Assign a material to an object (replacing any existing)."""
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def add_to(name, parent, obj):
    """Parent obj under parent, set name."""
    obj.name = name
    obj.parent = parent
    return obj


# ---- Primitive wrappers (match Three.js conventions used in models.js) ----
# Note: in Blender, +Z is up. Our Three.js models had forward = +Z, up = +Y.
# We'll BUILD the model in Blender's native orientation (up=+Z, forward=-Y by
# convention for "looking forward"), then orient the root group on import so
# the game sees forward=+Z, up=+Y. For simplicity we build forward=-Y here.

def cone(name, radius=1, depth=1, vertices=12, location=(0,0,0), rotation=(0,0,0), material=None):
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices, radius1=radius, radius2=0, depth=depth,
        location=location, rotation=rotation,
    )
    obj = bpy.context.active_object
    obj.name = name
    flat_shade(obj)
    if material:
        assign(obj, material)
    return obj


def cylinder(name, radius=1, depth=1, vertices=12, radius2=None, location=(0,0,0), rotation=(0,0,0), material=None):
    r2 = radius if radius2 is None else radius2
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=depth,
        location=location, rotation=rotation,
    )
    obj = bpy.context.active_object
    obj.name = name
    # If tapered, reshape top ring via a simple scale of upper vertices
    if radius2 is not None and radius2 != radius:
        # scale only the top cap vertices (those with max local z)
        _scale_top_ring(obj, radius2 / radius)
    flat_shade(obj)
    if material:
        assign(obj, material)
    return obj


def _scale_top_ring(obj, factor):
    mesh = obj.data
    top_z = max(v.co.z for v in mesh.vertices)
    for v in mesh.vertices:
        if abs(v.co.z - top_z) < 1e-4:
            v.co.x *= factor
            v.co.y *= factor


def cube(name, size=(1,1,1), location=(0,0,0), rotation=(0,0,0), material=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0]/2, size[1]/2, size[2]/2)  # cube_add size=1 -> 2-unit; scale to half-extents style
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    flat_shade(obj)
    if material:
        assign(obj, material)
    return obj


def ico(name, radius=1, subdivisions=0, location=(0,0,0), material=None):
    bpy.ops.mesh.primitive_ico_sphere_add(radius=radius, subdivisions=subdivisions, location=location)
    obj = bpy.context.active_object
    obj.name = name
    flat_shade(obj)
    if material:
        assign(obj, material)
    return obj


def uv_sphere(name, radius=1, segments=8, rings=4, location=(0,0,0), material=None):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, segments=segments, ring_count=rings, location=location)
    obj = bpy.context.active_object
    obj.name = name
    flat_shade(obj)
    if material:
        assign(obj, material)
    return obj


def torus(name, major_radius=1, minor_radius=0.2, major_segments=8, minor_segments=4, location=(0,0,0), rotation=(0,0,0), material=None):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius, minor_radius=minor_radius,
        major_segments=major_segments, minor_segments=minor_segments,
        location=location, rotation=rotation,
    )
    obj = bpy.context.active_object
    obj.name = name
    flat_shade(obj)
    if material:
        assign(obj, material)
    return obj


def capsule(name, radius=0.5, depth=1, location=(0,0,0), rotation=(0,0,0), material=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    # Blender 4.x/5.x has no direct capsule primitive; approximate with cylinder + two hemispheres
    bpy.ops.object.delete()
    # build manually
    cyl = cylinder(name + "_cyl", radius=radius, depth=depth, vertices=10, location=location, rotation=rotation, material=material)
    return cyl  # cylinder is close enough for low-poly


def empty(name, location=(0,0,0)):
    bpy.ops.object.empty_add(type='PLAIN_AXES', location=location)
    obj = bpy.context.active_object
    obj.name = name
    return obj


def group(name, location=(0,0,0)):
    """Create an empty to act as a parent group."""
    return empty(name, location)


def select_only(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_scale(obj):
    """Bake the object's scale into its mesh data. Safe to call at any point —
    unlike a bare transform_apply, this makes `obj` active first."""
    select_only(obj)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj


def save_blend(path):
    bpy.ops.wm.save_as_mainfile(filepath=path)


def export_glb(path, draco=True):
    """Export the whole scene as a single GLB.

    Draco is on because these are 10k-triangle models: uncompressed, the seven
    assets total ~4 MB, which is a real download. Draco takes that to a few
    hundred KB at no visual cost. The runtime pairs this with a locally bundled
    DRACOLoader (see src/assets.js) — no CDN.
    """
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=False,
        export_apply=True,
        export_yup=True,        # Three.js convention: Y up
        export_tangents=False,
        export_materials='EXPORT',
        export_vertex_color='MATERIAL',
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_draco_mesh_compression_enable=draco,
        export_draco_mesh_compression_level=10,
        # 12-bit positions span a ~12-unit airframe in 4096 steps, about 3 mm of
        # model space — far below anything visible at chase-camera range — and
        # cost two bits per component less than the default 14.
        #
        # Do not expect much from tightening these further: measured, the whole
        # quantization change bought only ~5%. At a 40k budget the file is
        # dominated by CONNECTIVITY, not attributes, because the panel-inset
        # detail produces many small disconnected faces — precisely the topology
        # Draco compresses worst. Normals stay at 10 bits for that reason: the
        # extra two bits are nearly free here and 8 risks visible lighting steps.
        export_draco_position_quantization=12,
        export_draco_normal_quantization=10,
        export_draco_color_quantization=8,
    )


def join_meshes(objs, new_name):
    """Join a specific list of mesh objects into one.

    The result keeps objs[0]'s parent and object transform (Blender folds every
    other object's geometry into that space), so this is safe to call on parts
    living under an animated empty — no reparenting, no double transforms.

    This is a draw-call optimization, not a geometry one: triangle count is
    unchanged, but a 90-part airframe collapses from ~90 draws to one per
    material. With ten enemies on screen that is the difference between ~1000
    draw calls and ~60.
    """
    objs = [o for o in objs if o is not None and o.type == 'MESH']
    if not objs:
        return None
    if len(objs) == 1:
        joined = objs[0]
    else:
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        joined = bpy.context.active_object
    joined.name = new_name
    flat_shade(joined)
    return joined


def join_except(root, keep_substrings, new_name):
    """Join every mesh under `root` except those whose name contains one of
    `keep_substrings` (case-insensitive). Used to merge an airframe while
    leaving runtime-animated parts — flames, engine glows, nav lights — as
    independent objects the game can still find and drive."""
    keys = tuple(k.lower() for k in keep_substrings)
    targets = [m for m in collect_meshes(root)
               if not any(k in m.name.lower() for k in keys)]
    return join_meshes(targets, new_name)




# ---------------------------------------------------------------------------
# Detail helpers — surface greebling that reads as panel lines / plating.
# These are what actually make a model look "built" rather than just smooth.
# ---------------------------------------------------------------------------

def _bmesh_for(obj):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    return bm


def _bmesh_back(bm, obj):
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def detail_pass(obj, coarse=0.030, fine=0.012, bevel=0.006, micro=None):
    """Two nested panel-line passes plus an edge bevel.

    A single inset gives one recessed panel per face. Insetting the *result*
    again subdivides each of those panels into a plate with its own seam, which
    is what real hard-surface plating looks like — and it roughly doubles the
    face count while every added triangle is doing visible work. This is how the
    models reach a 20k budget without simply being smoothed blobs: the polygons
    become plating and relief, not denser approximations of the same shape.
    """
    panel_inset(obj, thickness=coarse, depth=-coarse * 0.4)
    panel_inset(obj, thickness=fine, depth=-fine * 0.35)
    if micro:
        # Third pass: fastener-scale relief inside each plate.
        panel_inset(obj, thickness=micro, depth=-micro * 0.3)
    if bevel:
        bevel_edges(obj, width=bevel, segments=2)
    return obj


def panel_inset(obj, thickness=0.012, depth=-0.004, faces_filter=None, max_faces=None):
    """Inset every face slightly and push it in, creating recessed panel lines.

    This roughly triples the face count while producing genuine surface relief
    that catches the key light — the single highest value-per-triangle detail
    pass for hard-surface models.
    """
    import bmesh
    if obj.type != 'MESH':
        return obj
    bm = _bmesh_for(obj)
    faces = [f for f in bm.faces if (faces_filter is None or faces_filter(f))]
    if max_faces is not None:
        faces = sorted(faces, key=lambda f: -f.calc_area())[:max_faces]
    if faces:
        bmesh.ops.inset_individual(
            bm, faces=faces, thickness=thickness, depth=depth, use_even_offset=True,
        )
    _bmesh_back(bm, obj)
    flat_shade(obj)
    return obj


def bevel_edges(obj, width=0.006, segments=2, angle_limit=math.radians(35)):
    """Bevel sharp edges so silhouettes catch a highlight instead of reading
    as a razor edge. Adds geometry along every qualifying edge."""
    import bmesh
    if obj.type != 'MESH':
        return obj
    bm = _bmesh_for(obj)
    edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > angle_limit]
    if edges:
        bmesh.ops.bevel(
            bm, geom=edges, offset=width, segments=segments, profile=0.5,
            affect='EDGES', clamp_overlap=True,
        )
    _bmesh_back(bm, obj)
    flat_shade(obj)
    return obj


def subdivide_mesh(obj, cuts=1):
    """Uniformly subdivide — use on curved surfaces where a denser wire genuinely
    improves the silhouette (fuselage barrels, nose cones, canopies)."""
    import bmesh
    if obj.type != 'MESH':
        return obj
    bm = _bmesh_for(obj)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    _bmesh_back(bm, obj)
    flat_shade(obj)
    return obj


# ---------------------------------------------------------------------------
# Triangle counting + poly-budget normalization
# ---------------------------------------------------------------------------

def tri_count(obj):
    """Triangles in one mesh object (n-gons counted as n-2 triangles)."""
    if obj.type != 'MESH':
        return 0
    return sum(max(len(p.vertices) - 2, 1) for p in obj.data.polygons)


def collect_meshes(root):
    """All mesh descendants of root, depth-first."""
    out = []
    def walk(o):
        for c in o.children:
            if c.type == 'MESH':
                out.append(c)
            walk(c)
    walk(root)
    return out


def total_tris(root):
    return sum(tri_count(m) for m in collect_meshes(root))


def _apply_decimate(obj, ratio):
    """Apply a collapse decimate at `ratio` to a single mesh object."""
    if obj.type != 'MESH' or ratio >= 1.0:
        return
    select_only(obj)
    m = obj.modifiers.new(name="_dec", type='DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = max(ratio, 0.02)
    bpy.ops.object.modifier_apply(modifier=m.name)


def normalize_tris(root, target_lo=10000, target_hi=11000, protect_below=60, passes=6):
    """Bring the whole model into the [target_lo, target_hi] triangle window.

    Builds are authored deliberately *above* the window, then collapsed down —
    decimating detailed geometry preserves far more character than subdividing
    simple geometry into the same count. Small parts (nav lights, pitot tubes)
    below `protect_below` triangles are left alone so they don't dissolve.

    Iterates because per-object decimation rounds independently, so a single
    global ratio lands near but not exactly on target.
    """
    target = (target_lo + target_hi) // 2
    for _ in range(passes):
        meshes = collect_meshes(root)
        cur = sum(tri_count(m) for m in meshes)
        if target_lo <= cur <= target_hi:
            return cur
        if cur <= target_lo:
            # Under budget. Prefer ANOTHER PANEL PASS over subdivision: insetting
            # again turns each existing plate into a smaller plate with its own
            # seam, so the triangles we add are relief the light can catch.
            # Uniform subdivision just makes a denser copy of the same surface —
            # the "smooth blob" outcome — so it is the last resort, used only
            # when insetting can no longer close the gap.
            meshes.sort(key=lambda m: -tri_count(m))
            big = [m for m in meshes if tri_count(m) >= protect_below]
            before = cur
            for m in big[:max(1, len(big) // 2)]:
                panel_inset(m, thickness=0.010, depth=-0.003)
                if total_tris(root) > target_hi:
                    break
            if total_tris(root) <= before * 1.02:
                # Insetting stopped paying off (faces too small to inset again).
                for m in meshes[:max(1, len(meshes) // 3)]:
                    subdivide_mesh(m, cuts=1)
                    if total_tris(root) > target_hi:
                        break
            continue
        # Over budget: collapse proportionally, protecting the small detail bits.
        protected = sum(tri_count(m) for m in meshes if tri_count(m) < protect_below)
        reducible = cur - protected
        want = target - protected
        if reducible <= 0 or want <= 0:
            break
        ratio = max(want / reducible, 0.02)
        for m in meshes:
            if tri_count(m) >= protect_below:
                _apply_decimate(m, ratio)
    return total_tris(root)


# ---------------------------------------------------------------------------
# LOD chain generation
# ---------------------------------------------------------------------------

def build_lod_chain(root, name, ratios=(0.28, 0.075, 0.02)):
    """Duplicate `root`'s meshes into progressively decimated LOD groups.

    Produces sibling empties named "<name>_LOD1", "<name>_LOD2", ... alongside
    the original, which is renamed "<name>_LOD0". The runtime reads these into
    a THREE.LOD so heavily instanced scenery costs almost nothing at distance
    while still carrying full detail up close.
    """
    src_meshes = collect_meshes(root)
    if not src_meshes:
        return []
    root.name = f"{name}_LOD0"
    made = []
    for level, ratio in enumerate(ratios, start=1):
        holder = empty(f"{name}_LOD{level}", location=tuple(root.location))
        holder.parent = root.parent
        for src in src_meshes:
            dup = src.copy()
            dup.data = src.data.copy()
            dup.name = f"{src.name}_L{level}"
            bpy.context.collection.objects.link(dup)
            # Re-root the duplicate under the LOD holder, preserving world placement.
            dup.parent = holder
            dup.matrix_parent_inverse = src.matrix_parent_inverse.copy()
            _apply_decimate(dup, ratio)
            flat_shade(dup)
        made.append(holder)
    return made
