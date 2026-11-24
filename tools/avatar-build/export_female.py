"""Build the Sign Saathi woman and export her as a VRM 1.0 the app can load."""
import bpy, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ss
from dress_female import dressed
from export_male import export

OUT_VRM = os.path.join(ss.OUT, 'signsaathi_female.vrm')
CREDIT = 'Body and face from MakeHuman (CC0) via MPFB; shalwar kameez and hijab modelled for Sign Saathi'

if __name__ == '__main__':
    body, rig, parts, garments, cut = dressed()
    export(body, rig, parts, garments, OUT_VRM, 'Sign Saathi Female', CREDIT)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ss.OUT, 'signsaathi_female.blend'))
