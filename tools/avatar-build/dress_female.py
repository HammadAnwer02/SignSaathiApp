"""Dress the woman in a shalwar kameez and hijab, and render her: full length, three-quarter, chest-up and the face."""
import bpy, os, sys, math
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ss, male, female, clothes, hijab
from test_dress import relax_arms, studio

# deep plum cloth with a berry hijab framed in cream, the colours of the app's current female signer
# (deeper than the MToon stand-in's, since the app's environment light lifts PBR cloth)
KAMEEZ = '#43203b'
HIJAB = '#76284b'
BAND = '#d8c49e'


def bust_line(body, rig):
    """Height of the bust's fullest point: the most forward skin either side of the breastbone."""
    skin = clothes.skin_points(body)
    lo, hi = ss.bone_world(rig, 'spine_02').z, ss.bone_world(rig, 'spine_03').z + 0.15
    sel = skin[(np.abs(skin[:, 0]) > 0.04) & (np.abs(skin[:, 0]) < 0.13) & (skin[:, 2] > lo) & (skin[:, 2] < hi)]
    return float(sel[np.argmin(sel[:, 1]), 2])


def dressed():
    body, rig, parts = female.build()
    male.tpose(rig)
    cut = clothes.Cut(rig)
    cut.hem = ss.bone_world(rig, 'calf_l').z - 0.09      # her kameez falls to mid-calf
    # modest cut: roomier, and falling straight down from the bust rather than shaping to it
    cut.chest = bust_line(body, rig)
    cut.ease, cut.fall = 0.014, 0.8
    shalwar = clothes.make_shalwar(body, cut)
    kameez, _ = clothes.make_kameez(body, rig, cut, collar=False, under=shalwar)
    deltas = male.add_expressions(body, parts)
    cloth = ss.simple_material('female_cloth', None, roughness=0.88, color=ss.srgb(KAMEEZ))
    scarf = ss.simple_material('female_hijab', None, roughness=0.9, color=ss.srgb(HIJAB))
    band = ss.simple_material('female_band', None, roughness=0.9, color=ss.srgb(BAND))
    for m in (scarf, band):
        m.use_backface_culling = False      # one layer of cloth, seen from both sides at the face opening
    veil, shape = hijab.make_hijab(body, rig, parts, kameez, deltas, scarf, band)
    under = hijab.make_underscarf(body, shape, deltas, band)
    clothes.uncovered_body(body, cut, also=hijab.hidden_skin(body, shape))
    female.materials(body, parts)
    for ob in (kameez, shalwar):
        ss.set_material(ob, cloth)
        clothes.solidify(ob)
    garments = dict(kameez=kameez, shalwar=shalwar, hijab=veil, underscarf=under)
    return body, rig, parts, garments, cut


if __name__ == '__main__':
    body, rig, parts, garments, cut = dressed()
    for ob in [body] + list(garments.values()):
        print('MESH', ob.name, len(ob.data.vertices), 'verts', len(ob.data.polygons), 'faces')
    studio()
    relax_arms(rig, down=50)
    eye = male.eye_centre(parts)
    full = ss.Vector((0, 0, 0.82))
    ss.render(ss.camera_at('full', full, 4.4, lens=50), os.path.join(ss.OUT, 'f_full.png'), (700, 1200))
    ss.render(ss.camera_at('full34', full, 4.4, yaw_deg=-35, lens=50), os.path.join(ss.OUT, 'f_full34.png'), (700, 1200))
    ss.render(ss.camera_at('chest', eye + ss.Vector((0, 0, -0.25)), 1.9, lens=50), os.path.join(ss.OUT, 'f_chest.png'), (800, 900))
    c = eye + ss.Vector((0, 0, -0.06))
    for i, yaw in enumerate((0, -40, 40, 180)):
        ss.render(ss.camera_at(f'h{i}', c, 0.95, yaw_deg=yaw, height=0.05), os.path.join(ss.OUT, f'f_head_{i}.png'), (520, 600))
