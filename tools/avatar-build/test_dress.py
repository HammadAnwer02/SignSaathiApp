"""Dress the man and render him: full length, three-quarter, chest-up and the collar."""
import bpy, os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ss, male, clothes


def dressed():
    body, rig, parts = male.build()
    male.tpose(rig)
    cut = clothes.Cut(rig)
    shalwar = clothes.make_shalwar(body, cut)
    kameez, collar = clothes.make_kameez(body, rig, cut, under=shalwar)
    # default specular keeps it a plain glTF material (no KHR_materials_specular, so three needn't use its physical shader)
    cloth = ss.simple_material('male_cloth', None, roughness=0.88, color=ss.srgb('#2f6b60'))
    pearl = ss.simple_material('male_buttons', None, roughness=0.35, specular=0.5, color=ss.srgb('#e9e4d6'))
    placket, buttons = clothes.placket_and_buttons(kameez, body, rig, cut, cloth, pearl)
    male.add_expressions(body, parts)
    clothes.uncovered_body(body, cut)
    male.materials(body, parts)
    for ob in (kameez, shalwar, collar):
        ss.set_material(ob, cloth)
        clothes.solidify(ob)
    garments = dict(kameez=kameez, collar=collar, shalwar=shalwar, placket=placket, buttons=buttons)
    return body, rig, parts, garments, cut


def relax_arms(rig, down=62):
    for name, sgn in (('upperarm_l', -1), ('upperarm_r', 1)):
        pb = rig.pose.bones[name]
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (0, 0, math.radians(sgn * down))
    for name in ('lowerarm_l', 'lowerarm_r'):
        pb = rig.pose.bones[name]
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (math.radians(-12), 0, 0)
    bpy.context.view_layer.update()


def studio():
    ss.setup_render(samples=32)
    sc = bpy.context.scene
    sc.view_settings.view_transform = 'Standard'
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.5
    bpy.data.lights['key'].energy = 160


if __name__ == '__main__':
    body, rig, parts, garments, cut = dressed()
    for ob in [body] + list(garments.values()):
        print('MESH', ob.name, len(ob.data.vertices), 'verts', len(ob.data.polygons), 'faces')
    studio()
    relax_arms(rig, down=50)
    eye = male.eye_centre(parts)
    full = ss.Vector((0, 0, 0.86))
    ss.render(ss.camera_at('full', full, 4.6, lens=50), os.path.join(ss.OUT, 'dress_full.png'), (700, 1200))
    ss.render(ss.camera_at('full34', full, 4.6, yaw_deg=-35, lens=50), os.path.join(ss.OUT, 'dress_full34.png'), (700, 1200))
    ss.render(ss.camera_at('chest', eye + ss.Vector((0, 0, -0.25)), 1.9, lens=50), os.path.join(ss.OUT, 'dress_chest.png'), (800, 900))
    ss.render(ss.camera_at('collar', eye + ss.Vector((0, 0, -0.17)), 0.9, yaw_deg=-25), os.path.join(ss.OUT, 'dress_collar.png'), (800, 800))
