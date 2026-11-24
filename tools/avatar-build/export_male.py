"""Build the Sign Saathi man and export him as a VRM 1.0 the app can load."""
import bpy, os, sys
from mathutils import Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ss, male, clothes
from test_dress import dressed
from bl_ext.user_default.vrm.editor.extension_accessor import get_armature_extension

OUT_VRM = os.path.join(ss.OUT, 'signsaathi_male.vrm')


def apply_modifier(ob, name):
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=name)


def add_eye_bones(rig, eyes):
    """VRM looks with eye bones; the game-engine rig has none, so give each eyeball its own."""
    world = [eyes.matrix_world @ v.co for v in eyes.data.vertices]
    inv = rig.matrix_world.inverted()
    centres = {}
    for name, pick in (('eye_l', lambda p: p.x > 0), ('eye_r', lambda p: p.x < 0)):
        pts = [p for p in world if pick(p)]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        centres[name] = (lo + hi) / 2
    with bpy.context.temp_override(active_object=rig, object=rig, selected_objects=[rig]):
        bpy.ops.object.mode_set(mode='EDIT')
        eb = rig.data.edit_bones
        for name, c in centres.items():
            b = eb.new(name)
            b.head = inv @ c
            b.tail = b.head + Vector((0, -0.025, 0))
            b.parent = eb['head']
            b.use_deform = True
        bpy.ops.object.mode_set(mode='OBJECT')
    for g in list(eyes.vertex_groups):
        eyes.vertex_groups.remove(g)
    groups = {n: eyes.vertex_groups.new(name=n) for n in centres}
    for v, p in zip(eyes.data.vertices, world):
        groups['eye_l' if p.x > 0 else 'eye_r'].add([v.index], 1.0, 'REPLACE')
    return centres


HUMANOID = {
    'hips': 'pelvis', 'spine': 'spine_01', 'chest': 'spine_02', 'upper_chest': 'spine_03',
    'neck': 'neck_01', 'head': 'head', 'left_eye': 'eye_l', 'right_eye': 'eye_r',
}
for side, s in (('left', 'l'), ('right', 'r')):
    HUMANOID.update({
        f'{side}_upper_leg': f'thigh_{s}', f'{side}_lower_leg': f'calf_{s}', f'{side}_foot': f'foot_{s}',
        f'{side}_toes': f'ball_{s}', f'{side}_shoulder': f'clavicle_{s}', f'{side}_upper_arm': f'upperarm_{s}',
        f'{side}_lower_arm': f'lowerarm_{s}', f'{side}_hand': f'hand_{s}',
        f'{side}_thumb_metacarpal': f'thumb_01_{s}', f'{side}_thumb_proximal': f'thumb_02_{s}',
        f'{side}_thumb_distal': f'thumb_03_{s}',
    })
    for vrm, mh in (('index', 'index'), ('middle', 'middle'), ('ring', 'ring'), ('little', 'pinky')):
        for i, seg in enumerate(('proximal', 'intermediate', 'distal'), 1):
            HUMANOID[f'{side}_{vrm}_{seg}'] = f'{mh}_0{i}_{s}'


MALE_CREDIT = 'Body, face and hair from MakeHuman (CC0) via MPFB; kameez shalwar modelled for Sign Saathi'


def setup_vrm(rig, meshes, eye_centre, name='Sign Saathi Male', credit=MALE_CREDIT):
    ext = get_armature_extension(rig.data)
    ext.spec_version = '1.0'
    vrm1 = ext.vrm1
    meta = vrm1.meta
    meta.vrm_name = name
    meta.version = '1'
    if not meta.authors:
        meta.authors.add()
    meta.authors[0].value = 'Sign Saathi'
    meta.copyright_information = credit
    meta.avatar_permission = 'onlyAuthor'
    meta.commercial_usage = 'corporation'
    meta.credit_notation = 'unnecessary'
    meta.modification = 'allowModification'
    hb = vrm1.humanoid.human_bones
    for prop, bone in HUMANOID.items():
        getattr(hb, prop).node.bone_name = bone
    preset = vrm1.expressions.preset
    for expr in male.RECIPES:
        e = getattr(preset, expr)
        e.morph_target_binds.clear()
        for ob in meshes:
            keys = ob.data.shape_keys
            if keys and expr in keys.key_blocks:
                b = e.morph_target_binds.add()
                b.node.mesh_object_name = ob.name
                b.index = expr
                b.weight = 1.0
    # mouth shapes give way to the emotions, as VRM's own presets do
    for expr in ('happy', 'angry', 'sad', 'surprised'):
        getattr(preset, expr).override_mouth = 'blend'
    la = vrm1.look_at
    la.type = 'bone'
    # the add-on writes this as given, so it has to be in glTF's axes (y up, +z forward), not Blender's
    off = eye_centre - ss.bone_world(rig, 'head')
    la.offset_from_head_bone = (off.x, off.z, -off.y)
    return ext


def export(body, rig, parts, garments, path, name='Sign Saathi Male', credit=MALE_CREDIT):
    """Name the meshes, map the humanoid and face shapes, and write a VRM 1.0."""
    # the cloth's thickness has to be real geometry in a glTF
    for ob in garments.values():
        if 'Thickness' in ob.modifiers:
            apply_modifier(ob, 'Thickness')
    add_eye_bones(rig, parts['eyes'])
    names = {body: 'Body'}
    names.update({parts[k]: k.capitalize() for k in ('eyes', 'eyebrows', 'eyelashes', 'teeth', 'tongue', 'hair') if k in parts})
    names.update({ob: k.capitalize() for k, ob in garments.items()})
    for ob, n in names.items():
        ob.name = n
        ob.data.name = n
    rig.name = 'Armature'
    for ob in bpy.data.objects:
        if ob.type == 'MESH' and ob not in names:
            print('STRAY MESH', ob.name)
    eye = (Vector(ss.bone_world(rig, 'eye_l')) + Vector(ss.bone_world(rig, 'eye_r'))) / 2
    setup_vrm(rig, list(names), eye, name, credit)
    for ob in names:
        print('EXPORT MESH', ob.name, len(ob.data.vertices), 'verts', len(ob.data.polygons), 'faces',
              'keys', [k.name for k in ob.data.shape_keys.key_blocks[1:]] if ob.data.shape_keys else [])
    res = bpy.ops.export_scene.vrm(filepath=path, armature_object_name=rig.name, ignore_warning=True)
    print('EXPORT', res, path, os.path.getsize(path) if os.path.exists(path) else 'missing')


def build_and_export(path=OUT_VRM):
    body, rig, parts, garments, cut = dressed()
    export(body, rig, parts, garments, path)
    return body, rig, parts, garments


if __name__ == '__main__':
    build_and_export()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ss.OUT, 'signsaathi_male.blend'))
