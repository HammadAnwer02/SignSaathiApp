"""Shared helpers for building the Sign Saathi signers with MPFB in headless Blender."""
import bpy, math, os, sys
from mathutils import Vector

from bl_ext.user_default.mpfb.services import HumanService, ObjectService

# SS_BUILD: the folder holding the Blender profile (blender-user/) and tools/Blender.app.
# SS_WORK: where renders, textures and exports go. Both default to the old side-by-side layout.
SP = os.environ.get('SS_BUILD') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.environ.get('SS_WORK') or os.path.join(SP, 'bl')
OUT = os.path.join(WORK, 'out')
os.makedirs(OUT, exist_ok=True)


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)


def build_human(info, subdiv=0):
    settings = HumanService.get_default_deserialization_settings()
    settings['subdiv_levels'] = subdiv
    base = {
        'phenotype': {}, 'rig': 'game_engine', 'eyes': '', 'eyebrows': '', 'eyelashes': '', 'teeth': '',
        'tongue': '', 'hair': '', 'proxy': '', 'clothes': [], 'targets': [], 'skin_mhmat': '',
        'skin_material_type': 'MAKESKIN', 'eyes_material_type': 'MAKESKIN', 'alternative_materials': {},
    }
    base.update(info)
    body = HumanService.deserialize_from_dict(base, settings)
    rig = ObjectService.find_object_of_type_amongst_nearest_relatives(body, 'Skeleton')
    parts = {}
    for kind in ['Eyes', 'Eyelashes', 'Eyebrows', 'Tongue', 'Teeth', 'Hair', 'Clothes']:
        ob = ObjectService.find_object_of_type_amongst_nearest_relatives(body, kind)
        if ob is not None:
            parts[kind.lower()] = ob
    return body, rig, parts


def bone_world(rig, name, tail=False):
    b = rig.data.bones[name]
    return rig.matrix_world @ (b.tail_local if tail else b.head_local)


def setup_render(res=(900, 1200), samples=32):
    sc = bpy.context.scene
    for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    try:
        sc.eevee.taa_render_samples = samples
    except AttributeError:
        pass
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'None'
    # a soft studio environment plus a key light, like a photo booth
    world = bpy.data.worlds.new('studio') if not sc.world else sc.world
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    hdr = os.path.join(bpy.utils.system_resource('DATAFILES'), 'studiolights', 'world', 'interior.exr')
    env.image = bpy.data.images.load(hdr)
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = 0.8
    out = nt.nodes.new('ShaderNodeOutputWorld')
    # light from the HDR, but a plain backdrop behind him
    mix = nt.nodes.new('ShaderNodeMixShader')
    lp = nt.nodes.new('ShaderNodeLightPath')
    plain = nt.nodes.new('ShaderNodeBackground')
    plain.inputs['Color'].default_value = (0.82, 0.8, 0.76, 1)
    plain.inputs['Strength'].default_value = 1.0
    nt.links.new(env.outputs['Color'], bg.inputs['Color'])
    nt.links.new(lp.outputs['Is Camera Ray'], mix.inputs['Fac'])
    nt.links.new(bg.outputs['Background'], mix.inputs[1])
    nt.links.new(plain.outputs['Background'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
    key = bpy.data.lights.new('key', 'AREA')
    key.energy = 220
    key.size = 1.2
    k = bpy.data.objects.new('key', key)
    bpy.context.collection.objects.link(k)
    k.location = (-1.2, -2.0, 2.2)
    k.rotation_euler = (math.radians(55), 0, math.radians(-30))
    rim = bpy.data.lights.new('rim', 'AREA')
    rim.energy = 120
    rim.size = 1.0
    r = bpy.data.objects.new('rim', rim)
    bpy.context.collection.objects.link(r)
    r.location = (1.4, 1.6, 2.0)
    r.rotation_euler = (math.radians(-60), 0, math.radians(35))


def camera_at(name, target, distance, yaw_deg=0.0, lens=85, height=0.0):
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = lens
    cam = bpy.data.objects.new(name, cam_data)
    bpy.context.collection.objects.link(cam)
    yaw = math.radians(yaw_deg)
    # he faces -Y; yaw turns the camera round him towards his left (+X)
    offset = Vector((math.sin(yaw) * distance, -math.cos(yaw) * distance, height))
    cam.location = target + offset
    direction = target - cam.location
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    return cam


def render(cam, path, res=None):
    sc = bpy.context.scene
    if res:
        sc.render.resolution_x, sc.render.resolution_y = res
    sc.camera = cam
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('RENDERED', path)


def report(body, rig, parts):
    print('BODY', body.name, len(body.data.vertices), 'verts', [m.name for m in body.modifiers])
    print('  groups', [g.name for g in body.vertex_groups if not g.name[0].islower() or g.name.startswith('helper') or g.name.startswith('joint')][:40])
    print('  shape keys', [k.name for k in body.data.shape_keys.key_blocks][:20] if body.data.shape_keys else None)
    print('  materials', [m.name for m in body.data.materials])
    for k, ob in parts.items():
        print('PART', k, ob.name, len(ob.data.vertices), 'verts', [m.name for m in ob.data.materials], [m.type for m in ob.modifiers])
    if rig:
        print('RIG', rig.name, len(rig.data.bones), 'bones')
        for b in ('head', 'neck_01', 'pelvis', 'spine_03', 'hand_l', 'upperarm_l', 'lowerarm_l'):
            if b in rig.data.bones:
                print('  ', b, tuple(round(c, 3) for c in bone_world(rig, b)), 'tail', tuple(round(c, 3) for c in bone_world(rig, b, True)))
    xs = [body.matrix_world @ v.co for v in body.data.vertices]
    print('  bbox z', round(min(v.z for v in xs), 3), round(max(v.z for v in xs), 3), 'x', round(min(v.x for v in xs), 3), round(max(v.x for v in xs), 3))


# ---------- materials that survive glTF/VRM export: one image into a Principled BSDF ----------
import numpy as np

UD = os.path.join(SP, 'blender-user', 'extensions', '.user', 'user_default', 'mpfb', 'data')
TEX = os.path.join(WORK, 'tex')
os.makedirs(TEX, exist_ok=True)


def load_pixels(path):
    img = bpy.data.images.load(path, check_existing=True)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    return img, px.reshape(h, w, 4)


def save_pixels(arr, path):
    h, w = arr.shape[:2]
    name = os.path.basename(path)
    if name in bpy.data.images:
        bpy.data.images.remove(bpy.data.images[name])
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.pixels.foreach_set(np.clip(arr, 0, 1).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    return bpy.data.images.load(path, check_existing=False)


def blend_skin(light_path, dark_path, t, out_path, warm=(1.0, 1.0, 1.0)):
    """MakeHuman mixes its light and dark skins for mixed ancestry; do the same, then warm it."""
    _, a = load_pixels(light_path)
    _, b = load_pixels(dark_path)
    mix = a * (1 - t) + b * t
    mix[..., :3] *= np.array(warm, dtype=np.float32)
    mix[..., 3] = 1
    return save_pixels(mix, out_path)


def tint_image(src_path, out_path, tint, keep_alpha=True, gain=1.0):
    _, a = load_pixels(src_path)
    out = a.copy()
    lum = (a[..., 0] * 0.3 + a[..., 1] * 0.59 + a[..., 2] * 0.11)[..., None]
    out[..., :3] = lum * gain * np.array(tint, dtype=np.float32)
    if not keep_alpha:
        out[..., 3] = 1
    return save_pixels(out, out_path)


def simple_material(name, image, roughness=0.5, alpha=False, specular=0.5, color=None, cutoff=0.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = 0.0
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = specular
    if image is not None:
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = image
        nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        if alpha:
            # alpha > cutoff is what glTF export reads as a MASK material
            clip = nt.nodes.new('ShaderNodeMath')
            clip.operation = 'GREATER_THAN'
            clip.inputs[1].default_value = cutoff
            nt.links.new(tex.outputs['Alpha'], clip.inputs[0])
            nt.links.new(clip.outputs['Value'], bsdf.inputs['Alpha'])
    elif color is not None:
        bsdf.inputs['Base Color'].default_value = (*color, 1)
    if alpha:
        mat.blend_method = 'HASHED' if hasattr(mat, 'blend_method') else None
    mat.use_backface_culling = not alpha
    return mat


def set_material(ob, mat):
    ob.data.materials.clear()
    ob.data.materials.append(mat)


def asset_tex(kind, name, file):
    return os.path.join(UD, kind, name, file)


def srgb(hexstr):
    """'#rrggbb' to the linear RGB Blender's colour inputs take."""
    h = hexstr.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)
