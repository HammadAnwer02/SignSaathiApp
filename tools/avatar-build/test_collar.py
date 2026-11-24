"""Close views of the collar, front and both sides."""
import bpy, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ss, male
from test_dress import dressed, studio
body, rig, parts, garments, cut = dressed()
studio()
eye = male.eye_centre(parts)
c = eye + ss.Vector((0, 0, -0.16))
for i, yaw in enumerate((0, -55, 55, 180)):
    ss.render(ss.camera_at(f'c{i}', c, 0.7, yaw_deg=yaw, height=0.12), os.path.join(ss.OUT, f'collar_{i}.png'), (520, 520))
