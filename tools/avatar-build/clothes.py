"""A kameez and shalwar for the man, cut from MakeHuman's own tights and skirt helper shells.

The helpers already carry the rig's weights and sit just off the skin, so the cloth bends with
the arms exactly as the skin under it does. Everything here assumes he stands in the T-pose,
facing -Y, with his left hand towards +X.
"""
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ss


def members(ob, name, thr=0.5):
    gi = ob.vertex_groups[name].index
    return np.array([any(e.group == gi and e.weight >= thr for e in v.groups) for v in ob.data.vertices])


def copy_object(src, name):
    ob = src.copy()
    ob.data = src.data.copy()
    ob.name = ob.data.name = name
    bpy.context.collection.objects.link(ob)
    if ob.data.shape_keys:
        ob.shape_key_clear()
    for m in list(ob.modifiers):
        if m.type != 'ARMATURE':
            ob.modifiers.remove(m)
    return ob


def keep(bm, mask):
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(~mask)[0]], context='VERTS')


def bisect(bm, co, no, keep_positive, geom=None, clear=True):
    geom = geom if geom is not None else bm.verts[:] + bm.edges[:] + bm.faces[:]
    return bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=Vector(co), plane_no=Vector(no).normalized(),
                                  clear_inner=clear and keep_positive, clear_outer=clear and not keep_positive)


def side(p, co, no):
    return (Vector(p) - Vector(co)).dot(Vector(no).normalized())


def smooth(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def smin(a, b, k):
    """min(a, b), rounded off over a width k where the two are close."""
    h = max(k - abs(a - b), 0.0) / k
    return min(a, b) - h * h * k * 0.25


def iso_cut(bm, field, seed):
    """Cut away the region where field(co) > 0 that is reachable from the seed vertices, along the field's zero.

    Faces are deleted whole only inside the region: every edge that leaves it is split where the field crosses zero,
    and each face it crosses is split between those points, so the new rim runs exactly along the contour instead
    of in the mesh's stair steps. Returns the rim's vertices.
    """
    vals = {v: field(v.co) for v in bm.verts}
    kill = {v for v in bm.verts if vals[v] > 0 and seed(v)}
    todo = list(kill)
    while todo:
        v = todo.pop()
        for e in v.link_edges:
            o = e.other_vert(v)
            if o not in kill and vals[o] > 0:
                kill.add(o)
                todo.append(o)
    crossing = [e for e in bm.edges if (e.verts[0] in kill) != (e.verts[1] in kill)]
    rim = set()
    for e in crossing:
        a, b = e.verts if e.verts[0] in kill else reversed(e.verts)
        t = min(0.99, max(0.01, vals[a] / (vals[a] - vals[b])))
        _, nv = bmesh.utils.edge_split(e, a, t)
        rim.add(nv)
    for f in list({f for v in rim for f in v.link_faces}):
        if not f.is_valid:
            continue
        loop = list(f.verts)
        ns = [i for i, v in enumerate(loop) if v in rim]
        if len(ns) == 2:
            bmesh.utils.face_split(f, loop[ns[0]], loop[ns[1]])
        elif len(ns) == 4:
            # a saddle: cut off the two pockets that lie in the region, keep the rest joined
            first = 0 if any(v in kill for v in loop[ns[0] + 1:ns[1]]) else 1
            pairs = [(loop[ns[first]], loop[ns[first + 1]]), (loop[ns[first + 2]], loop[ns[(first + 3) % 4]])]
            for a, b in pairs:
                shared = [g for g in a.link_faces if g in b.link_faces and g.is_valid]
                if shared and not any(set(e.verts) == {a, b} for e in shared[0].edges):
                    bmesh.utils.face_split(shared[0], a, b)
    bmesh.ops.delete(bm, geom=list(kill), context='VERTS')
    return [v for v in rim if v.is_valid]


class Cut:
    """Where the garment edges fall, measured off his skeleton."""

    def __init__(self, rig):
        b = lambda n, t=False: ss.bone_world(rig, n, t)
        self.hip = b('pelvis').z + 0.005                      # the skirt hangs from just above the hip joints
        self.hem = b('calf_l').z - 0.02                       # kameez to just below the knee
        self.cuff = b('hand_l').x - 0.012                     # sleeves end at the wrist
        self.ankle = b('foot_l').z + 0.03
        neck = b('neck_01')
        # the band collar: its top edge and its seam with the body, both lower at the front
        self.collar_no = Vector((0, -0.55, 1)).normalized()
        self.neckline = Vector((0, neck.y - 0.007, neck.z - 0.025))
        self.chest = b('spine_03').z + 0.06
        self.waist = b('pelvis').z + 0.1
        self.ease = 0.011        # how far the body of the kameez stands off the skin at the chest
        self.fall = 0.6          # how much of the way it falls straight down from the chest rather than drawing in
        self.neck_head, self.neck_tail = b('neck_01'), b('neck_01', True)
        self.neck_R = None      # the neckline's radius by angle, set when the kameez is cut
        self.front_room = 0.035

    def axis_at(self, z):
        """The neck's centre line; below the neck it drops straight down rather than leaning into the back."""
        h, t = self.neck_head, self.neck_tail
        if z <= h.z:
            return Vector((h.x, h.y, z))
        return h + (t - h) * ((z - h.z) / (t.z - h.z))

    def neck_polar(self, p):
        a = self.axis_at(p[2])
        dx, dy = p[0] - a.x, p[1] - a.y
        return math.hypot(dx, dy), math.atan2(dy, dx)

    def in_neck_zone(self, p):
        return p[2] > self.neck_head.z - 0.1


def radial(points, centre):
    d = points[:, :2] - centre[None, :2]
    return np.arctan2(d[:, 1], d[:, 0]), np.hypot(d[:, 0], d[:, 1])


def profile(points, centre, angles, width=math.radians(14), fill=False):
    """For each angle, the furthest a set of points reaches from the centre in that direction.

    Angles with no points give 0, or with `fill` (angles sorted, spanning the circle), the value interpolated
    round the circle from their nearest neighbours that have points."""
    th, r = radial(points, centre)
    out = np.zeros(len(angles))
    have = np.zeros(len(angles), dtype=bool)
    for i, a in enumerate(angles):
        diff = np.abs((th - a + math.pi) % (2 * math.pi) - math.pi)
        sel = diff < width
        if sel.any():
            out[i] = (r[sel] * np.cos(diff[sel])).max()
            have[i] = True
    if fill and have.any() and not have.all():
        a = np.asarray(angles, dtype=float)
        ka, kv = a[have], out[have]
        out[~have] = np.interp(a[~have], np.concatenate([ka - 2 * math.pi, ka, ka + 2 * math.pi]), np.tile(kv, 3))
    return out


def near_neck(bm, cut, radius=0.078):
    faces = [f for f in bm.faces if f.calc_center_median().z > cut.neckline.z - 0.08
             and math.hypot(f.calc_center_median().x, f.calc_center_median().y - cut.neckline.y) < radius]
    edges = list({e for f in faces for e in f.edges})
    verts = list({v for f in faces for v in f.verts})
    return verts + edges + faces


def skin_points(body):
    m = members(body, 'body')
    return np.array([body.matrix_world @ v.co for v, k in zip(body.data.vertices, m) if k])


def make_kameez(body, rig, cut, collar=True, under=None):
    """The kameez, and its band collar (None with collar=False, for a neckline the hijab covers).
    The skirt is sized to clear `under` (the shalwar) as well as the skirt helper."""
    skirt_pts = np.array([body.matrix_world @ v.co for v, m in zip(body.data.vertices, members(body, 'helper-skirt')) if m])
    under_pts = np.array([under.matrix_world @ v.co for v in under.data.vertices]) if under is not None else np.zeros((0, 3))
    # below the skirt helper's own hem, the skirt carries on straight down
    skirt_floor = skirt_pts[:, 2].min() + 0.03
    ob = copy_object(body, 'kameez')
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    keep(bm, members(body, 'helper-tights'))
    bisect(bm, (0, 0, cut.waist), (0, 0, 1), True)          # above the waist the tights are one tube
    bisect(bm, (cut.cuff, 0, 0), (-1, 0, 0), True)
    bisect(bm, (-cut.cuff, 0, 0), (1, 0, 0), True)
    # the collar is built separately: take the neck tube out with a cylinder round the neck, so the
    # neckline falls where the neck flares into the chest, shoulders and back, as a real one does
    z_tube = cut.neck_head.z + 0.03
    tube = np.array([v.co[:] for v in bm.verts if abs(v.co.z - z_tube) < 0.015 and cut.neck_polar(v.co)[0] < 0.1])
    ca = cut.axis_at(z_tube)
    grid = np.linspace(-math.pi, math.pi, 73)
    # (the tube's top edge dips at the front, under the jaw, so the front is filled in from either side)
    tube_r = profile(tube, np.array(ca[:]), grid, width=math.radians(12), fill=True) + 0.009
    # the neck leans forward, so below the tube's top the throat stands outside a cylinder that fits up there:
    # widen it towards the front and let the tilted plane set the neckline at the base of the throat
    tube_r = tube_r + cut.front_room * np.maximum(0.0, -np.sin(grid)) ** 2
    cut.neck_R = lambda phi: float(np.interp((phi + math.pi) % (2 * math.pi) - math.pi, grid, tube_r))
    plane_z = lambda p: cut.neckline.z - (cut.collar_no.y * (p[1] - cut.neckline.y)) / cut.collar_no.z

    # inside the neck's cylinder and above a neckline tilted lower at the front, as necklines are, rounded where
    # the two meet; only the tube reached from its top goes, never a patch of back or chest
    def depth(p):
        r, phi = cut.neck_polar(p)
        return smin(p[2] - plane_z(p), cut.neck_R(phi) - r, 0.012)

    neck_loop = iso_cut(bm, depth, lambda v: v.co.z > z_tube)
    for s in (1, -1):
        bisect(bm, (s * (cut.cuff - 0.045), 0, 0), (s, 0, 0), True, clear=False)
    bm.normal_update()
    cuff_seam = [v for v in bm.verts if abs(abs(v.co.x) - (cut.cuff - 0.045)) < 1e-4]
    ring_edges = [e for e in bm.edges if e.is_boundary and all(abs(v.co.z - cut.waist) < 1e-4 for v in e.verts)]

    # loosen it: roomy in the body and sleeve, close at the neck
    for v in bm.verts:
        p = v.co
        if abs(p.x) > 0.2:
            ease = 0.012 - 0.005 * smooth(0.25, cut.cuff, abs(p.x))
        else:
            ease = cut.ease + 0.006 * smooth(cut.chest, cut.waist, p.z)
        if cut.in_neck_zone(p):
            r, phi = cut.neck_polar(p)
            ease = 0.003 + (ease - 0.003) * smooth(cut.neck_R(phi), cut.neck_R(phi) + 0.05, r)
        v.co = p + v.normal * ease
    # below the chest it falls straight rather than following the waist in
    centre = np.array([0.0, float(np.mean([v.co.y for v in bm.verts if abs(v.co.x) < 0.16])), 0.0])
    torso = [v for v in bm.verts if abs(v.co.x) < 0.22 and v.co.z < cut.chest]
    chest_pts = np.array([v.co[:] for v in bm.verts if abs(v.co.x) < 0.2 and abs(v.co.z - cut.chest) < 0.03])
    angles, _ = radial(np.array([v.co[:] for v in torso]), centre)
    chest_r = profile(chest_pts, centre, angles)
    c2 = Vector((centre[0], centre[1], 0))
    for v, rc in zip(torso, chest_r):
        d = Vector((v.co.x, v.co.y, 0)) - c2
        r = d.length
        # partly: cloth falls from the chest but gravity still draws it in a little
        fall = cut.fall * smooth(cut.chest, cut.chest - 0.12, v.co.z) * smooth(0.22, 0.13, abs(v.co.x))
        want = max(r, r + (rc + 0.01 - r) * fall)
        if r > 1e-4:
            v.co.xy = (c2 + d * (want / r)).xy
    for v in cuff_seam:
        v.co -= v.normal * 0.002

    # the skirt: hang the waist ring to below the knee, shaped by MakeHuman's skirt helper
    print('KAMEEZ waist ring edges', len(ring_edges), 'neck loop', len(neck_loop))
    rings = 18
    for k in range(1, rings + 1):
        z = cut.waist + (cut.hem - cut.waist) * k / rings
        res = bmesh.ops.extrude_edge_only(bm, edges=ring_edges)
        new_v = [g for g in res['geom'] if isinstance(g, bmesh.types.BMVert)]
        new_set = set(new_v)
        ring_edges = [g for g in res['geom'] if isinstance(g, bmesh.types.BMEdge) and all(v in new_set for v in g.verts)]
        sl = skirt_pts[np.abs(skirt_pts[:, 2] - max(z, skirt_floor)) < 0.03]
        cz = sl.mean(0)
        sl = np.concatenate([sl, under_pts[np.abs(under_pts[:, 2] - z) < 0.03]])
        srcs = [next(e.other_vert(v) for e in v.link_edges if e.other_vert(v) not in new_set) for v in new_v]
        dirs = [Vector((s.co.x - cz[0], s.co.y - cz[1], 0)) for s in srcs]
        prof = profile(sl, cz, [math.atan2(d.y, d.x) for d in dirs])
        for v, d, rs in zip(new_v, dirs, prof):
            r = max(d.length, 1e-4)
            want = max(r, rs + 0.016) + 0.008 * k / rings
            v.co = Vector((cz[0], cz[1], z)) + d * (want / r)
    for f in bm.faces:
        f.smooth = True
    loop_pts = np.array([v.co[:] for v in neck_loop])
    lt = np.array([cut.neck_polar(p)[1] for p in loop_pts])
    o = np.argsort(lt)
    ext_t = np.concatenate([lt[o] - 2 * math.pi, lt[o], lt[o] + 2 * math.pi])
    ext_z = np.tile(loop_pts[o, 2], 3)
    cut.neck_foot = lambda phi: float(np.interp((phi + math.pi) % (2 * math.pi) - math.pi, ext_t, ext_z))
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return ob, (make_collar(body, rig, cut, loop_pts) if collar else None)


def make_collar(body, rig, cut, loop_pts, height=0.034, gap=math.radians(9), cols=60, rows=4):
    """A band collar standing round the neck, open at the front, its foot on the kameez neckline."""
    polar = [cut.neck_polar(p) for p in loop_pts]
    lt = np.array([ph for _, ph in polar])
    order = np.argsort(lt)
    lt, lp = lt[order], loop_pts[order]
    ext_t = np.concatenate([lt - 2 * math.pi, lt, lt + 2 * math.pi])
    ext_p = np.concatenate([lp, lp, lp])

    def foot(phi):
        a = (phi + math.pi) % (2 * math.pi) - math.pi
        return Vector([float(np.interp(a, ext_t, ext_p[:, i])) for i in range(3)])

    skin = skin_points(body)
    skin = skin[[cut.in_neck_zone(p) for p in skin]]
    skin_polar = np.array([cut.neck_polar(p) for p in skin])
    front = -math.pi / 2
    phis = [front + gap + (2 * math.pi - 2 * gap) * j / cols for j in range(cols + 1)]
    me = bpy.data.meshes.new('collar')
    bm = bmesh.new()
    feet = [foot(phi) for phi in phis]
    radii = []
    for phi, b in zip(phis, feet):
        zt = b.z + height
        # the neck's own radius at the collar's top edge, in this direction
        dphi = np.abs((skin_polar[:, 1] - phi + math.pi) % (2 * math.pi) - math.pi)
        sel = (dphi < math.radians(12)) & (np.abs(skin[:, 2] - zt) < 0.012) & (skin_polar[:, 0] < 0.1)
        radii.append(float(skin_polar[sel, 0].max()) if sel.any() else cut.neck_R(phi) - 0.012)
    # a band collar's top edge is one smooth curve, whatever the skin samples under it do
    radii = np.convolve(np.pad(radii, 3, mode='edge'), np.ones(7) / 7, mode='valid')
    grid = []
    for phi, b, rn in zip(phis, feet, radii):
        zt = b.z + height
        a = cut.axis_at(zt)
        d = Vector((math.cos(phi), math.sin(phi), 0))
        t = Vector((a.x, a.y, zt)) + d * (rn + 0.006)
        col = []
        for i in range(rows + 1):
            f = i / rows
            p = b.lerp(t, f) + d * 0.003 * math.sin(math.pi * f)
            col.append(bm.verts.new(p))
        grid.append(col)
    for j in range(cols):
        for i in range(rows):
            bm.faces.new((grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1])).smooth = True
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    f0 = bm.faces[len(bm.faces) // 2]
    cm = f0.calc_center_median()
    a = cut.axis_at(cm.z)
    if f0.normal.dot(Vector((cm.x - a.x, cm.y - a.y, 0))) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('collar', me)
    bpy.context.collection.objects.link(ob)
    ob.parent = rig
    transfer_weights(ob, body)
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig
    return ob


def transfer_weights(target, body):
    """Give each vertex the bone weights of the nearest skin vertex."""
    from mathutils.kdtree import KDTree
    skin_mask = members(body, 'body')
    verts = [v for v, k in zip(body.data.vertices, skin_mask) if k]
    kd = KDTree(len(verts))
    for i, v in enumerate(verts):
        kd.insert(body.matrix_world @ v.co, i)
    kd.balance()
    bone_names = {b.name for b in target.parent.data.bones}
    groups = {g.index: g.name for g in body.vertex_groups if g.name in bone_names}
    for name in groups.values():
        if name not in target.vertex_groups:
            target.vertex_groups.new(name=name)
    for tv in target.data.vertices:
        _, i, _ = kd.find(target.matrix_world @ tv.co)
        for e in verts[i].groups:
            if e.group in groups and e.weight > 0:
                target.vertex_groups[groups[e.group]].add([tv.index], e.weight, 'REPLACE')


def make_shalwar(body, cut):
    ob = copy_object(body, 'shalwar')
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    keep(bm, members(body, 'helper-tights'))
    bisect(bm, (0, 0, cut.waist), (0, 0, 1), False)
    bisect(bm, (0, 0, cut.ankle), (0, 0, 1), True)
    bisect(bm, (0, 0, cut.ankle + 0.05), (0, 0, 1), True, clear=False)     # the gathered cuff
    bm.normal_update()
    for v in bm.verts:
        z = v.co.z
        # full and gathered at the ankle below the kameez; under it, close to the leg so it never shows through
        bag = smooth(cut.ankle + 0.05, cut.ankle + 0.25, z) * smooth(cut.hem + 0.12, cut.hem - 0.02, z)
        ease = 0.006 + 0.022 * bag - 0.012 * smooth(cut.hip, cut.waist, z)
        v.co += v.normal * ease
        if abs(z - (cut.ankle + 0.05)) < 1e-4:
            v.co -= v.normal * 0.004
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return ob


def placket_and_buttons(kameez, body, rig, cut, cloth, button_mat):
    """A short buttoned placket down the chest: a raised strip and three buttons."""
    bm = bmesh.new()
    bm.from_mesh(kameez.data)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    front = kameez_front_neckline(kameez, cut)
    # the placket carries the collar's front opening on down the chest
    top = front - 0.005
    length, half, rows = 0.15, 0.013, 10
    pts = []
    for i in range(rows + 1):
        z = top - length * i / rows
        row = []
        for x in (-half, 0.0, half):
            hit = tree.ray_cast(Vector((x, -1.0, z)), Vector((0, 1, 0)))
            row.append(hit[0] + hit[1] * 0.0015)
        pts.append(row)
    pb = bmesh.new()
    grid = [[pb.verts.new(p) for p in row] for row in pts]
    for i in range(rows):
        for j in range(2):
            pb.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
    pb.normal_update()
    pb.faces.ensure_lookup_table()
    if pb.faces[0].normal.y > 0:
        bmesh.ops.reverse_faces(pb, faces=pb.faces[:])
    me = bpy.data.meshes.new('placket')
    pb.to_mesh(me)
    pb.free()
    placket = bpy.data.objects.new('placket', me)
    bm = bmesh.new()
    for i in range(3):
        z = top - 0.03 - i * 0.05
        hit = tree.ray_cast(Vector((0, -1.0, z)), Vector((0, 1, 0)))
        sph = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=6, radius=0.005)
        for v in sph['verts']:
            v.co = Vector((v.co.x, v.co.y * 0.4, v.co.z)) + hit[0] + hit[1] * 0.0035
    me = bpy.data.meshes.new('buttons')
    bm.to_mesh(me)
    bm.free()
    buttons = bpy.data.objects.new('buttons', me)
    for ob, mat in ((placket, cloth), (buttons, button_mat)):
        bpy.context.collection.objects.link(ob)
        ob.parent = rig
        transfer_weights(ob, body)
        mod = ob.modifiers.new('Armature', 'ARMATURE')
        mod.object = rig
        ss.set_material(ob, mat)
    return placket, buttons


def kameez_front_neckline(kameez, cut):
    """Height of the neckline at the front centre."""
    rim = [v.co for v in kameez.data.vertices if cut.in_neck_zone(v.co)
           and cut.neck_polar(v.co)[0] < cut.neck_R(cut.neck_polar(v.co)[1]) + 0.012 and v.co.y < cut.axis_at(v.co.z).y]
    front = [p for p in rim if abs(p.x) < 0.035] or rim
    return min(p.z for p in front)


def solidify(ob, thickness=0.003):
    m = ob.modifiers.new('Thickness', 'SOLIDIFY')
    m.thickness = thickness
    m.offset = -1
    m.use_even_offset = True
    # cloth is thick at the turned edges
    m.use_rim = True
    # thicken before the rig bends it, so it can be applied for export
    ob.modifiers.move(len(ob.modifiers) - 1, 0)
    return m


def uncovered_body(body, cut, also=None):
    """Drop the skin the clothes hide, keeping a margin at the cuffs and collar; `also` marks more to drop."""
    bm = bmesh.new()
    bm.from_mesh(body.data)
    helpers = members(body, 'HelperGeometry', 0.01) | members(body, 'JointCubes', 0.01)
    if also is not None:
        helpers = helpers | also
    kill = []
    bm.verts.ensure_lookup_table()
    for v in bm.verts:
        if helpers[v.index]:
            kill.append(v)
            continue
        p = v.co
        if cut.in_neck_zone(p):
            # round the neck, only what lies well under the neckline is covered
            r, phi = cut.neck_polar(p)
            hidden = p.z < cut.neck_foot(phi) - 0.025 and abs(p.x) < cut.cuff - 0.035
        else:
            hidden = abs(p.x) < cut.cuff - 0.035 and p.z > cut.ankle + 0.035
        if hidden:
            kill.append(v)
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    bm.to_mesh(body.data)
    bm.free()
    for g in list(body.vertex_groups):
        if g.name.startswith(('helper-', 'joint-')) or g.name in ('HelperGeometry', 'JointCubes', 'Left', 'Mid', 'Right', 'body'):
            body.vertex_groups.remove(g)
    for m in list(body.modifiers):
        if m.type == 'MASK':
            body.modifiers.remove(m)
