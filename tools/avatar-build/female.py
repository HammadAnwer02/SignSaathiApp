"""The Sign Saathi woman: a MakeHuman body built like the man's, T-posed, with the same seven face shapes."""
import bpy, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ss, male

INFO = {
    'name': 'SignSaathiFemale',
    'phenotype': {
        'gender': 0.0, 'age': 0.5, 'muscle': 0.5, 'weight': 0.5, 'proportions': 0.5, 'height': 0.42,
        'cupsize': 0.42, 'firmness': 0.5, 'race': dict(male.RACES),
    },
    # fuller lips, a little more nose, softer cheekbones than his
    'targets': [
        {'target': 'nose-hump-incr', 'value': 0.1},
        {'target': 'nose-scale-vert-incr', 'value': 0.1},
        {'target': 'mouth-lowerlip-volume-incr', 'value': 0.2},
        {'target': 'mouth-upperlip-volume-incr', 'value': 0.15},
        {'target': 'l-cheek-bones-incr', 'value': 0.1},
        {'target': 'r-cheek-bones-incr', 'value': 0.1},
        {'target': 'head-oval', 'value': 0.3},
    ],
    'eyes': 'high-poly/high-poly.mhclo',
    'eyebrows': 'eyebrow010/eyebrow010.mhclo',
    'eyelashes': 'eyelashes02/eyelashes02.mhclo',
    'teeth': 'teeth_base/teeth_base.mhclo',
    'tongue': 'tongue01/tongue01.mhclo',
    'hair': '',     # pinned up under the hijab
    'skin_mhmat': 'young_caucasian_female/young_caucasian_female.mhmat',
}

LIGHT = ss.asset_tex('skins', 'young_caucasian_female', 'young_lightskinned_female_diffuse.png')
DARK = ss.asset_tex('skins', 'young_african_female', 'young_darkskinned_female_diffuse.png')


def build(info=INFO):
    return male.build(info)


def materials(body, parts, skin_t=0.5):
    male.materials(body, parts, skin_t=skin_t, who='female', info=INFO, light=LIGHT, dark=DARK,
                   warm=(1.0, 0.96, 0.92), brows=(0.07, 0.05, 0.04))
