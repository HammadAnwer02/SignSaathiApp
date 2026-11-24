"""The Sign Saathi man: MakeHuman body, T-posed, with the seven face shapes the app drives."""
import bpy, os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ss
from bl_ext.user_default.mpfb.services import TargetService, RigService, ClothesService, LocationService
from bl_ext.user_default.mpfb.entities.clothes.mhclo import Mhclo

MPFB_DATA = LocationService.get_mpfb_data()
RACES = {'caucasian': 0.75, 'african': 0.15, 'asian': 0.10}

INFO = {
    'name': 'SignSaathiMale',
    'phenotype': {
        'gender': 1.0, 'age': 0.55, 'muscle': 0.55, 'weight': 0.5, 'proportions': 0.5, 'height': 0.45,
        'cupsize': 0.5, 'firmness': 0.5, 'race': dict(RACES),
    },
    # a little more nose, fuller lips, higher cheekbones and lower, heavier brows
    'targets': [
        {'target': 'nose-hump-incr', 'value': 0.25},
        {'target': 'nose-scale-vert-incr', 'value': 0.15},
        {'target': 'nose-point-width-incr', 'value': 0.1},
        {'target': 'mouth-lowerlip-volume-incr', 'value': 0.2},
        {'target': 'mouth-upperlip-volume-incr', 'value': 0.1},
        {'target': 'l-cheek-bones-incr', 'value': 0.2},
        {'target': 'r-cheek-bones-incr', 'value': 0.2},
        {'target': 'chin-prominent-incr', 'value': 0.15},
        {'target': 'head-oval', 'value': 0.3},
        {'target': 'eyebrows-trans-down', 'value': 0.15},
    ],
    'eyes': 'high-poly/high-poly.mhclo',
    'eyebrows': 'eyebrow009/eyebrow009.mhclo',
    'eyelashes': 'eyelashes01/eyelashes01.mhclo',
    'teeth': 'teeth_base/teeth_base.mhclo',
    'tongue': 'tongue01/tongue01.mhclo',
    'hair': 'short04/short04.mhclo',
    'skin_mhmat': 'young_caucasian_male/young_caucasian_male.mhmat',
}

# MakeHuman's expression units, mixed into the presets the app drives (see solver.ts EXPRESSIONS)
RECIPES = {
    'blink': {'eye-left-closure': 1.0, 'eye-right-closure': 1.0},
    'aa': {'mouth-open': 0.55},
    # rounded, pushed-out lips held nearly closed: any wider and they frame the upper teeth
    'ou': {'mouth-pursing': 1.0, 'mouth-protusion': 0.6, 'mouth-compression': 0.45},
    'happy': {'mouth-corner-puller': 0.9, 'eye-left-slit': 0.35, 'eye-right-slit': 0.35},
    'surprised': {'eyebrows-left-up': 1.0, 'eyebrows-right-up': 1.0, 'eye-left-opened-up': 0.6,
                  'eye-right-opened-up': 0.6, 'mouth-open': 0.3},
    'angry': {'eyebrows-left-down': 1.0, 'eyebrows-right-down': 1.0, 'eye-left-slit': 0.3,
              'eye-right-slit': 0.3, 'mouth-compression': 0.5},
    'sad': {'eyebrows-left-inner-up': 1.0, 'eyebrows-right-inner-up': 1.0, 'mouth-depression': 0.7},
}
FACE_PARTS = ('eyebrows', 'eyelashes', 'teeth', 'tongue', 'hair')


def coords(ob, key=None):
    n = len(ob.data.vertices)
    a = np.empty(n * 3, dtype=np.float32)
    (key.data if key is not None else ob.data.vertices).foreach_get('co', a)
    return a.reshape(n, 3)


def build(info=INFO):
    ss.clear_scene()
    return ss.build_human(info)


def tpose(rig):
    """Bake the body shape, then make MPFB's T-pose the rest pose (VRM expects one)."""
    with open(os.path.join(MPFB_DATA, 'poses', 'game_engine_fk', 't-pose.json')) as f:
        pose = json.load(f)
    # MPFB's own setter needs pose mode; headless, write the rotations directly
    for pb in rig.pose.bones:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
    for name, value in pose['bone_rotations'].items():
        pb = rig.pose.bones[name]
        if len(value) == 4:
            pb.rotation_mode = 'QUATERNION'
            pb.rotation_quaternion = value
        else:
            pb.rotation_euler = value
    bpy.context.view_layer.update()
    RigService.apply_pose_as_rest_pose(rig)


def unit_deltas(body, names):
    base = coords(body)
    out = {}
    for name in names:
        d = np.zeros_like(base)
        for race, w in RACES.items():
            path = os.path.join(MPFB_DATA, 'targets', 'expression', 'units', race, name + '.target.gz')
            key = TargetService.load_target(body, path, weight=0.0, name=f'tmp-{race}-{name}')
            d += w * (coords(body, key) - base)
            body.shape_key_remove(key)
        out[name] = d
    return out


def interpolate(ob, deltas):
    """Carry the body's face shapes onto a fitted part through its MHCLO binding."""
    m = Mhclo()
    m.load(ClothesService.find_clothes_absolute_path(ob))
    n = len(ob.data.vertices)
    idx = np.zeros((n, 3), dtype=np.int64)
    wts = np.zeros((n, 3), dtype=np.float32)
    for i in range(n):
        idx[i] = m.verts[i]['verts']
        wts[i] = m.verts[i]['weights']
    if not ob.data.shape_keys:
        ob.shape_key_add(name='Basis', from_mix=False)
    base = coords(ob)
    for expr, d in deltas.items():
        pd = (d[idx] * wts[..., None]).sum(1)
        if np.abs(pd).max() < 1e-5:
            continue
        k = ob.shape_key_add(name=expr, from_mix=False)
        k.data.foreach_set('co', (base + pd).ravel())
        k.value = 0.0


def add_expressions(body, parts, recipes=RECIPES):
    units = unit_deltas(body, sorted({u for r in recipes.values() for u in r}))
    if not body.data.shape_keys:
        body.shape_key_add(name='Basis', from_mix=False)
    base = coords(body)
    deltas = {}
    for expr, recipe in recipes.items():
        d = sum(w * units[u] for u, w in recipe.items())
        deltas[expr] = d
        k = body.shape_key_add(name=expr, from_mix=False)
        k.data.foreach_set('co', (base + d).ravel())
        k.value = 0.0
    # teeth and tongue only ride the jaw; the lip units would push them through the lips
    jaw = {expr: recipe.get('mouth-open', 0.0) * units['mouth-open'] for expr, recipe in recipes.items() if 'mouth-open' in recipe}
    # pursed lips part in front of the upper teeth: draw the teeth and tongue back and up, behind the upper lip
    if 'ou' in recipes:
        jaw['ou'] = jaw.get('ou', np.zeros_like(units['mouth-open'])) + np.array([0.0, 0.008, 0.006], dtype=np.float32)
    for kind in FACE_PARTS:
        if kind in parts:
            interpolate(parts[kind], jaw if kind in ('teeth', 'tongue') else deltas)
    return deltas


def set_expression(objs, name, value=1.0):
    for ob in objs:
        keys = ob.data.shape_keys
        if not keys:
            continue
        for k in keys.key_blocks[1:]:
            k.value = value if k.name == name else 0.0


LIGHT = ss.asset_tex('skins', 'young_caucasian_male', 'young_lightskinned_male_diffuse.png')
DARK = ss.asset_tex('skins', 'young_african_male', 'young_darkskinned_male_diffuse.png')


def materials(body, parts, skin_t=0.52, who='male', info=INFO, light=LIGHT, dark=DARK, warm=(1.0, 0.97, 0.93),
              brows=(0.06, 0.045, 0.036)):
    """One plain image material per part; the woman's build passes her own skins, assets and name prefix."""
    skin = ss.blend_skin(light, dark, skin_t, os.path.join(ss.TEX, f'{who}_skin.png'), warm)
    ss.set_material(body, ss.simple_material(f'{who}_skin', skin, roughness=0.55))
    ss.set_material(parts['eyes'], ss.simple_material(f'{who}_eyes', eye_texture(who), roughness=0.1, alpha=True))
    brow = info['eyebrows'].split('/')[0]
    img = ss.tint_image(ss.asset_tex('eyebrows', brow, brow + '.png'), os.path.join(ss.TEX, f'{who}_brows.png'), brows)
    ss.set_material(parts['eyebrows'], ss.simple_material(f'{who}_brows', img, roughness=0.8, alpha=True, cutoff=0.3))
    lash = info['eyelashes'].split('/')[0]
    img = ss.tint_image(ss.asset_tex('eyelashes', lash, lash + '.png'), os.path.join(ss.TEX, f'{who}_lashes.png'), (0.03, 0.025, 0.02))
    ss.set_material(parts['eyelashes'], ss.simple_material(f'{who}_lashes', img, roughness=0.8, alpha=True, cutoff=0.3))
    if 'hair' in parts:
        hair = info['hair'].split('/')[0]
        img = ss.tint_image(ss.asset_tex('hair', hair, hair + '_diffuse.png'), os.path.join(ss.TEX, f'{who}_hair.png'), (0.05, 0.042, 0.037), gain=1.8)
        ss.set_material(parts['hair'], ss.simple_material(f'{who}_hair', img, roughness=0.55, alpha=True, cutoff=0.35))
    ss.set_material(parts['teeth'], ss.simple_material(f'{who}_teeth', bpy.data.images.load(ss.asset_tex('teeth', 'teeth_base', 'teeth.png')), roughness=0.3))
    ss.set_material(parts['tongue'], ss.simple_material(f'{who}_tongue', bpy.data.images.load(ss.asset_tex('tongue', 'tongue01', 'tongue01_diffuse.png')), roughness=0.4))


def eye_centre(parts):
    eyes = parts['eyes']
    pts = coords(eyes) @ np.array(eyes.matrix_world)[:3, :3].T + np.array(eyes.matrix_world)[:3, 3]
    return ss.Vector(pts.mean(0).tolist())


def eye_texture(who='male'):
    """MakeHuman's brown iris is a red maroon; turn it a deep brown and calm the pink sclera."""
    _, a = ss.load_pixels(ss.asset_tex('eyes', 'materials', 'brown_eye.png'))
    rgb = a[..., :3]
    lum = rgb @ np.array([0.3, 0.59, 0.11], dtype=np.float32)
    iris = np.clip((rgb[..., 0] - rgb[..., 2] - 0.12) / 0.15, 0, 1) * np.clip((0.55 - lum) / 0.15, 0, 1)
    brown = np.array([0.40, 0.25, 0.14], dtype=np.float32) / 0.2814
    dark = (lum * 0.8)[..., None] * brown
    calm = lum[..., None] * 0.6 + rgb * 0.4
    out = a.copy()
    out[..., :3] = calm * (1 - iris[..., None]) + dark * iris[..., None]
    return ss.save_pixels(out, os.path.join(ss.TEX, f'{who}_eyes.png'))
