"""A khimar-style hijab for the Sign Saathi woman, ported from the app's old runtime one (src/avatar/wardrobe/hijab.ts,
since removed; it is in git at commit 49e36b9).

From a point in the middle of the head, every direction is followed out to two convex hulls: one round the head
alone and one round the head, neck and upper body (over the kameez) together. Near the face the cloth follows the
head hull, so it sits close round the face; lower down it follows the larger hull, so it falls straight from the
head to the shoulders and chest, the way a draped cloth bridges the neck. The face opening and the hem are then cut
along smooth curves, and a band of a second colour frames the face.

Blender axes: z up, she faces -y, her left hand is towards +x.
"""
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ss
from clothes import members

FIT = dict(
    ease=0.011,     # how far the cloth stands off the head and body
    bun=0.02,       # extra fullness at the back of the head, over hair pinned up underneath
    # the face opening stays generous: brows, eyes, cheeks and mouth all carry grammar in sign language
    brow=0.026,     # face opening: top edge above the brows,
    chin=0.006,     # bottom edge below the chin,
    cheek=0.016,    # sides beyond the outer eye corners
    front=0.145,    # how far below the shoulder line the drape falls at the front
    back=0.13,      # and at the back
    band=0.1,       # width of the band round the face, as a fraction of the opening
    sides=0.008,    # extra fullness at the sides of the head
    folds=0.0045,   # depth of the soft folds the drape falls into
)
OVAL = 2.2          # roundness of the face opening (2 is an ellipse)


def smooth(e0, e1, x):
    t = np.clip((np.asarray(x, dtype=float) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


class Hull:
    """A convex hull as outward planes n.p = c, for finding where rays from inside leave it."""

    def __init__(self, pts):
        bm = bmesh.new()
        for p in pts:
            bm.verts.new(Vector(p))
        bmesh.ops.convex_hull(bm, input=bm.verts[:])
        centre = np.asarray(pts).mean(0)
        n, c = [], []
        for f in bm.faces:
            if f.calc_area() < 1e-9:
                continue
            f.normal_update()
            nn = np.array(f.normal[:])
            p0 = np.array(f.verts[0].co[:])
            if nn @ (np.array(f.calc_center_median()[:]) - centre) < 0:
                nn = -nn
            n.append(nn)
            c.append(nn @ p0)
        bm.free()
        self.n = np.array(n)
        self.c = np.array(c)

    def exit(self, o, dirs, grow):
        """Distance from o along each unit direction to the hull grown outward by `grow` (scalar or per direction)."""
        den = dirs @ self.n.T
        num = self.c[None, :] + np.reshape(grow, (-1, 1)) - (self.n @ o)[None, :]
        t = np.where(den > 1e-6, num / np.where(den > 1e-6, den, 1.0), np.inf)
        return t.min(1)


def group_weight(ob, names):
    """Each vertex's total weight in the named vertex groups."""
    idx = {ob.vertex_groups[n].index for n in names if n in ob.vertex_groups}
    return np.array([sum(e.weight for e in v.groups if e.group in idx) for v in ob.data.vertices])


def world(ob):
    m = np.array(ob.matrix_world)
    co = np.empty(len(ob.data.vertices) * 3)
    ob.data.vertices.foreach_get('co', co)
    return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


def measure(body, rig, parts, kameez, fit):
    head_w = group_weight(body, ['head'])
    skin = members(body, 'body')
    pts = world(body)
    head_pts = pts[skin & (head_w > 0.5)]
    arm_bones = {b.name for side in 'lr' for b in rig.data.bones[f'upperarm_{side}'].children_recursive}
    arm_bones |= {'upperarm_l', 'upperarm_r'}
    arms = [ss.bone_world(rig, f'upperarm_{s}') for s in 'lr']
    shoulder = max(a.z for a in arms) + 0.035
    reach = max(abs(a.x) for a in arms) + 0.035
    lowest = shoulder - max(fit['front'], fit['back']) - 0.04
    torso = []
    for ob, mask in ((body, skin), (kameez, np.ones(len(kameez.data.vertices), dtype=bool))):
        p = world(ob)
        hw = group_weight(ob, ['head'])
        lw = group_weight(ob, arm_bones)
        keep = mask & (hw < 0.5) & (lw < 0.1) & (p[:, 2] > lowest) & (np.abs(p[:, 0]) < reach)
        torso.append(p[keep])
    torso_pts = np.concatenate(torso)

    eyes = world(parts['eyes'])
    eye_z = (eyes[:, 2].min() + eyes[:, 2].max()) / 2
    brow_top = world(parts['eyebrows'])[:, 2].max()
    # middle of the head: on the midline at eye height, halfway between the face and the back of the head
    band = head_pts[np.abs(head_pts[:, 2] - eye_z) < 0.03]
    centre = np.array([0.0, (band[:, 1].min() + band[:, 1].max()) / 2, eye_z])
    # chin: the lowest point of the face on the midline, close behind the tip of the nose
    mid = head_pts[np.abs(head_pts[:, 0]) < 0.012]
    nose = mid[mid[:, 2] < eye_z, 1].min()
    chin = mid[(mid[:, 2] < eye_z - 0.02) & (mid[:, 1] < nose + 0.035), 2].min()
    m = dict(centre=centre, eye_z=eye_z, eye_outer=np.abs(eyes[:, 0]).max(), brow_top=brow_top, chin=chin,
             shoulder=shoulder)
    print('HIJAB measure', {k: np.round(v, 4) for k, v in m.items()}, 'head pts', len(head_pts), 'torso pts', len(torso_pts))
    return m, head_pts, torso_pts


def cut(tris, field, pos):
    """Split triangles along the zero set of a per-vertex field (see cut.ts); returns triangles and which are >= 0."""
    out, inside, made = [], [], {}
    f = {}

    def val(v):
        if v not in f:
            f[v] = field(pos[v])
        return f[v]

    def cross(a, b):
        lo, hi = min(a, b), max(a, b)
        if (lo, hi) not in made:
            fl, fh = val(lo), val(hi)
            pos.append(pos[lo] + (pos[hi] - pos[lo]) * (fl / (fl - fh)))
            made[(lo, hi)] = len(pos) - 1
        return made[(lo, hi)]

    for tri in tris:
        sgn = [val(v) >= 0 for v in tri]
        n = sum(sgn)
        if n in (0, 3):
            out.append(tri)
            inside.append(n == 3)
            continue
        lone = sgn.index(True) if n == 1 else sgn.index(False)
        p, q, r = tri[lone], tri[(lone + 1) % 3], tri[(lone + 2) % 3]
        pq, pr = cross(p, q), cross(p, r)
        out += [(p, pq, pr), (pq, q, r), (pq, r, pr)]
        inside += [n == 1, n != 1, n != 1]
    return out, inside


def edges_of(faces):
    e = np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1)
    uniq, count = np.unique(e, axis=0, return_counts=True)
    return uniq, uniq[count == 1]


def relax(verts, faces, iterations=10, lam=0.5, mu=-0.53):
    """Taubin smoothing: rounds off the flat facets the hulls leave without shrinking the cloth onto the head.
    Open edges stay put."""
    edges, border = edges_of(faces)
    fixed = np.zeros(len(verts), dtype=bool)
    fixed[border.ravel()] = True
    deg = np.bincount(edges.ravel(), minlength=len(verts)).astype(float)
    p = verts.copy()
    for _ in range(iterations):
        for k in (lam, mu):
            acc = np.zeros_like(p)
            np.add.at(acc, edges[:, 0], p[edges[:, 1]])
            np.add.at(acc, edges[:, 1], p[edges[:, 0]])
            step = acc / np.maximum(deg, 1)[:, None] - p
            step[fixed] = 0
            p = p + k * step
    return p


def normals(verts, faces):
    n = np.cross(verts[faces[:, 1]] - verts[faces[:, 0]], verts[faces[:, 2]] - verts[faces[:, 0]])
    vn = np.zeros_like(verts)
    for k in range(3):
        np.add.at(vn, faces[:, k], n)
    return vn / np.maximum(np.linalg.norm(vn, axis=1), 1e-12)[:, None]


def drape_folds(verts, faces, C, m, fit):
    """Soft vertical folds in the drape, deepening from the chin to the hem; the cap round the head stays smooth."""
    n = normals(verts, faces)
    if np.mean(np.sum(n * (verts - C), axis=1)) < 0:
        n = -n
    u = np.arctan2(verts[:, 0] - C[0], C[1] - verts[:, 1])
    wave = 0.5 + 0.35 * np.sin(14 * u) + 0.15 * np.sin(23 * u + 1.3)
    depth = fit['folds'] * smooth(m['chin'], m['shoulder'] - 0.06, verts[:, 2])
    return verts + n * (depth * wave)[:, None]


def make_hijab(body, rig, parts, kameez, deltas, cloth, band_mat, fit=FIT):
    """The hijab as a mesh skinned to head, neck_01 and spine_03, with the body's face shapes carried onto it."""
    m, head_pts, torso_pts = measure(body, rig, parts, kameez, fit)
    C = m['centre']
    head_hull = Hull(head_pts)
    all_hull = Hull(np.concatenate([head_pts, torso_pts]))
    half = m['eye_outer'] + fit['cheek']
    top = m['brow_top'] + fit['brow'] - m['eye_z']
    bottom = m['eye_z'] - (m['chin'] - fit['chin'])

    def oval(p):
        p = np.atleast_2d(p)
        dx, dz, df = p[:, 0] - C[0], p[:, 2] - C[2], C[1] - p[:, 1]
        # only the front of the head opens; fade the test out round the sides so the cloth doesn't crease
        front = smooth(0.15, 0.45, df / np.maximum(np.sqrt(dx * dx + dz * dz + df * df), 1e-9))
        s = np.abs(dx / half) ** OVAL + np.abs(dz / np.where(dz > 0, top, bottom)) ** OVAL
        # straight behind the head s is 0 too, but nothing opens there
        return np.where(front > 1e-3, s / np.maximum(front, 1e-3), 1e6)

    def hem_z(p):
        p = np.atleast_2d(p)
        c = np.cos(np.arctan2(p[:, 0] - C[0], C[1] - p[:, 1]))
        return m['shoulder'] - fit['front'] * np.maximum(0, c) ** 1.4 - fit['back'] * np.maximum(0, -c) ** 1.4

    # a sphere of directions: the crown, then rings down to nearly straight below
    NU, NV, V_MAX = 112, 92, 2.9
    u = np.arange(NU) / NU * 2 * math.pi
    v = np.arange(1, NV + 1) / NV * V_MAX
    vv, uu = np.meshgrid(v, u, indexing='ij')
    dirs = np.stack([np.sin(vv) * np.sin(uu), -np.sin(vv) * np.cos(uu), np.cos(vv)], -1).reshape(-1, 3)
    dirs = np.concatenate([[[0.0, 0.0, 1.0]], dirs])
    t_drape = all_hull.exit(C, dirs, fit['ease'])
    at = C + dirs * t_drape[:, None]
    away = smooth(1, 2, oval(at))
    # below the chin the cloth hangs from the head to the body, except where it is pinned round the face
    drape = smooth(m['chin'] + 0.03, m['chin'] - 0.05, at[:, 2]) * away
    bun_dir = np.array([0.0, 1.0, 0.3]) / math.hypot(1.0, 0.3)
    bun = fit['bun'] * np.maximum(0, dirs @ bun_dir) ** 2
    # hair under the cloth fills out the sides of the head above the ears, so it doesn't narrow to a point
    bun = bun + fit['sides'] * dirs[:, 0] ** 2 * smooth(-0.3, 0.1, dirs[:, 2])
    t_head = head_hull.exit(C, dirs, 0.0025 + (fit['ease'] + bun - 0.0025) * away)
    t = t_head + (t_drape - t_head) * drape
    pos = list(C + dirs * t[:, None])

    ring = lambda j, i: 1 + (j - 1) * NU + (i % NU)
    tris = [(0, ring(1, i + 1), ring(1, i)) for i in range(NU)]
    for j in range(1, NV):
        for i in range(NU):
            a, b, c, e = ring(j, i), ring(j, i + 1), ring(j + 1, i + 1), ring(j + 1, i)
            tris += [(a, c, e), (a, b, c)]
    # round off the hulls' flat facets on the whole sphere first, so every cut after this lands on its contour
    pos = list(relax(np.array(pos), np.array(tris)))
    tris, inside = cut(tris, lambda p: p[2] - hem_z(p)[0], pos)
    tris = [t for t, k in zip(tris, inside) if k]
    tris, inside = cut(tris, lambda p: oval(p)[0] - 1, pos)
    tris = [t for t, k in zip(tris, inside) if k]
    tris, inside = cut(tris, lambda p: oval(p)[0] - (1 + fit['band']) ** OVAL, pos)
    mats = [0 if k else 1 for k in inside]

    used = sorted({v for t in tris for v in t})
    remap = {v: i for i, v in enumerate(used)}
    verts = np.array([pos[v] for v in used])
    faces = np.array([[remap[v] for v in t] for t in tris])
    verts = drape_folds(verts, faces, C, m, fit)
    me = bpy.data.meshes.new('hijab')
    me.from_pydata(verts.tolist(), [], faces.tolist())
    me.update()
    print('HIJAB clearance: closest skin %.4f m' % min_gap(verts, body))
    for poly, mi in zip(me.polygons, mats):
        poly.material_index = mi
        poly.use_smooth = True
    ob = bpy.data.objects.new('hijab', me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(cloth)
    ob.data.materials.append(band_mat)
    # outward normals: the crown's must point up
    top_poly = max(me.polygons, key=lambda p: p.center.z)
    if top_poly.normal.z < 0:
        me.flip_normals()

    # skin: the cap rides the head; the drape shares itself between head, neck and chest down towards the hem
    o = oval(verts)
    # (the cloth within a few centimetres of the face opening goes with the head, so a nod doesn't fold it into the chin)
    dr = smooth(m['chin'] + 0.02, m['chin'] - 0.06, verts[:, 2]) * smooth(1.3, 3.0, o)
    tt = np.clip((verts[:, 2] - m['shoulder']) / (m['chin'] - m['shoulder']), 0, 1)
    w = {'head': 1 - dr + dr * tt * tt, 'neck_01': dr * 2 * tt * (1 - tt), 'spine_03': dr * (1 - tt) ** 2}
    total = sum(w.values())
    for name, wt in w.items():
        g = ob.vertex_groups.new(name=name)
        for i, x in enumerate(wt / total):
            if x > 1e-4:
                g.add([i], float(x), 'REPLACE')
    ob.parent = rig
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig

    # face shapes: the cloth pinned round the face and under the chin moves with the skin it lies on
    body_pts = world(body)
    kd = KDTree(len(body_pts))
    for i, p in enumerate(body_pts):
        kd.insert(p, i)
    kd.balance()
    near = [kd.find_n(Vector(p), 4) for p in verts]
    ob.shape_key_add(name='Basis', from_mix=False)
    for expr, d in deltas.items():
        moved = np.zeros_like(verts)
        for i, hits in enumerate(near):
            ws = [(1.0 / max(dist, 1e-4), idx) for _, idx, dist in hits]
            tot = sum(x for x, _ in ws)
            moved[i] = sum(x * d[idx] for x, idx in ws) / tot * smooth(0.035, 0.012, hits[0][2])
        if np.abs(moved).max() < 1e-5:
            continue
        k = ob.shape_key_add(name=expr, from_mix=False)
        k.data.foreach_set('co', (verts + moved).ravel())
        k.value = 0.0
    print('HIJAB', len(verts), 'verts', len(tris), 'tris', 'keys', [k.name for k in ob.data.shape_keys.key_blocks[1:]])
    return ob, dict(oval=oval, hem_z=hem_z, measure=m)


def make_underscarf(body, shape, deltas, mat, lift=0.0015):
    """The cream under-cap that shows inside the face opening below the chin: a copy of the skin under the jaw and
    down the front and sides of the neck, lifted off it a little. Being made of that skin, it has the skin's own
    bone weights, and the jaw's face shapes are carried over, so it can never part from the neck when she nods."""
    import bmesh
    from clothes import copy_object, keep
    m = shape['measure']
    p = world(body)
    o = shape['oval'](p)
    skin = members(body, 'body')
    dz = p[:, 2] - m['chin']
    front = p[:, 1] < m['centre'][1] + 0.03
    want = skin & front & (dz < 0.015) & (dz > -0.075) & (o > 0.9)
    ob = copy_object(body, 'underscarf')
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    orig = bm.verts.layers.int.new('orig')
    for v in bm.verts:
        v[orig] = v.index
    keep(bm, want)
    # only whole faces, lifted along their normals
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * lift
    idx = np.array([v[orig] for v in bm.verts])
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    for poly in ob.data.polygons:
        poly.use_smooth = True
    ss.set_material(ob, mat)
    base = np.empty(len(ob.data.vertices) * 3)
    ob.data.vertices.foreach_get('co', base)
    base = base.reshape(-1, 3)
    ob.shape_key_add(name='Basis', from_mix=False)
    for expr, d in deltas.items():
        dd = d[idx]
        if np.abs(dd).max() < 1e-5:
            continue
        k = ob.shape_key_add(name=expr, from_mix=False)
        k.data.foreach_set('co', (base + dd).ravel())
        k.value = 0.0
    print('UNDERSCARF', len(ob.data.vertices), 'verts', len(ob.data.polygons), 'faces')
    return ob


def min_gap(verts, body):
    """How close the cloth comes to the skin anywhere (a check that smoothing didn't sink it in)."""
    pts = world(body)[members(body, 'body')]
    kd = KDTree(len(pts))
    for i, p in enumerate(pts):
        kd.insert(p, i)
    kd.balance()
    return min(kd.find(Vector(p))[2] for p in verts)


def hidden_skin(body, shape, margin=1.8):
    """Skin the hijab covers well inside its edges: the scalp, ears and neck, kept clear of the face opening and hem.
    Under the chin it all goes, right up to the opening, or a nod would push it out through the drape."""
    p = world(body)
    o = shape['oval'](p)
    covered = (o > margin) | ((o > 1.05) & (p[:, 2] < shape['measure']['chin'] + 0.005))
    return covered & (p[:, 2] > shape['hem_z'](p) + 0.04)
