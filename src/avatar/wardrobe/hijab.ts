// A hijab in the khimar style: a cap that fits the head and frames the face, falling into a drape over the neck,
// shoulders and chest. It is built when the avatar loads, from the model's own head and body, and skinned to the
// head, neck and chest so it moves with the signer.
//
// Shape: from a point in the middle of the head, every direction is followed out to two convex hulls, one round the
// head alone and one round the head, neck and upper body together. Near the face the cloth follows the head hull,
// so it sits close round the face. Lower down it follows the larger hull, so it falls straight from the head to
// the shoulders and chest, the way a draped cloth bridges the neck. The face opening and the hem are then cut
// along smooth curves.

import {
  Box3, BufferGeometry, Float32BufferAttribute, Matrix4, SkinnedMesh, Uint16BufferAttribute, Uint32BufferAttribute,
  Vector3, type Material, type Skeleton,
} from 'three'
import { ConvexHull } from 'three/addons/math/ConvexHull.js'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import { cut, keep } from './cut'
import { addGroups } from './fabric'
import { armBones, bindPosition, boneSet, normalise, packInfluences, weightIn, type Influences, type Part } from './skinning'

export interface HijabFit {
  /** how far the cloth stands off the head and body (m) */
  ease: number
  /** extra fullness at the back of the head, over hair pinned up underneath (m) */
  bun: number
  /** face opening: top edge above the brows, bottom edge below the chin, sides beyond the outer eye corners (m) */
  brow: number
  chin: number
  cheek: number
  /** how far below the shoulder line the drape falls at the front and at the back (m) */
  front: number
  back: number
  /** width of the band round the face, as a fraction of the opening */
  band: number
}

export const DEFAULT_FIT: HijabFit = {
  ease: 0.011,
  bun: 0.02,
  brow: 0.018,
  chin: 0.008,
  cheek: 0.012,
  front: 0.17,
  back: 0.15,
  band: 0.1,
}

/** roundness of the face opening (2 is an ellipse) */
const OVAL = 2.2

interface Hull {
  n: Float32Array
  c: Float32Array
}

function hull(points: Vector3[]): Hull {
  const faces = new ConvexHull().setFromPoints(points).faces
  const n = new Float32Array(faces.length * 3)
  const c = new Float32Array(faces.length)
  faces.forEach((f, i) => {
    f.normal.toArray(n, i * 3)
    c[i] = f.constant
  })
  return { n, c }
}

/** Distance from o (inside the hull) along the unit vector d to the hull grown outward by `grow`. */
function exit(h: Hull, o: Vector3, d: Vector3, grow: number): number {
  const { n, c } = h
  let t = Infinity
  for (let i = 0, k = 0; i < c.length; i++, k += 3) {
    const den = n[k] * d.x + n[k + 1] * d.y + n[k + 2] * d.z
    if (den <= 1e-6) continue
    const ti = (c[i] + grow - (n[k] * o.x + n[k + 1] * o.y + n[k + 2] * o.z)) / den
    if (ti < t) t = ti
  }
  return t
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** The landmarks the hijab is fitted to, in bind space. */
export interface HeadMeasure {
  /** +1 when the model faces +z in bind space (VRM 1.0), -1 when it faces -z (VRM 0.x) */
  fwd: number
  centre: Vector3
  eyeY: number
  eyeOuter: number
  browTop: number
  chinY: number
  shoulderY: number
}

function measure(vrm: VRM, parts: Part[], skeleton: Skeleton, fit: HijabFit) {
  const raw = (name: VRMHumanBoneName) => vrm.humanoid?.getRawBoneNode(name) ?? null
  const head = raw('head')
  const neck = raw('neck')
  const chest = raw('upperChest') ?? raw('chest')
  const arms = [raw('leftUpperArm'), raw('rightUpperArm')]
  const index = (o: typeof head) => (o ? skeleton.bones.indexOf(o as (typeof skeleton.bones)[number]) : -1)
  const bones = { head: index(head), neck: index(neck), chest: index(chest) }
  const headAt = bindPosition(skeleton, head)
  const armsAt = arms.map((a) => bindPosition(skeleton, a))
  if (bones.head < 0 || bones.neck < 0 || bones.chest < 0 || !headAt || !armsAt[0] || !armsAt[1]) return null

  const box = (re: RegExp) => {
    const b = new Box3()
    const v = new Vector3()
    for (const p of parts) {
      if (!re.test(p.material.name)) continue
      for (let i = 0; i < p.pos.length; i += 3) b.expandByPoint(v.fromArray(p.pos, i))
    }
    return b
  }
  const eyes = box(/EyeWhite|EyeIris/)
  if (eyes.isEmpty()) return null
  const brows = box(/FaceBrow/)
  const eyeY = (eyes.min.y + eyes.max.y) / 2
  const fwd = (eyes.min.z + eyes.max.z) / 2 >= headAt.z ? 1 : -1
  const shoulderY = Math.max(armsAt[0].y, armsAt[1].y) + 0.035

  const headSet = boneSet(skeleton, [head])
  const limbSet = new Set([
    ...armBones(skeleton, raw('leftShoulder'), arms[0]),
    ...armBones(skeleton, raw('rightShoulder'), arms[1]),
  ])
  // the drape rests on the shoulders, not the arms (which are straight out to the sides in the bind pose)
  const reach = Math.max(Math.abs(armsAt[0].x), Math.abs(armsAt[1].x)) + 0.035
  const lowest = shoulderY - Math.max(fit.front, fit.back) - 0.04
  const headPts: Vector3[] = []
  const torsoPts: Vector3[] = []
  for (const p of parts) {
    const name = p.material.name
    const skin = /_SKIN/i.test(name)
    if (!skin && !/_CLOTH/i.test(name)) continue
    if (/Shoes|Bottoms|Hair/i.test(name)) continue
    const hw = weightIn(p.mesh.geometry, headSet)
    const lw = weightIn(p.mesh.geometry, limbSet)
    for (let v = 0; v < hw.length; v++) {
      const pt = new Vector3().fromArray(p.pos, v * 3)
      if (skin && hw[v] > 0.5) headPts.push(pt)
      else if (hw[v] < 0.5 && lw[v] < 0.1 && pt.y > lowest && Math.abs(pt.x) < reach) torsoPts.push(pt)
    }
  }
  if (headPts.length < 50 || torsoPts.length < 50) return null

  // middle of the head: on the midline at eye height, halfway between the face and the back of the head
  let front = -Infinity
  let back = Infinity
  for (const p of headPts) {
    if (Math.abs(p.y - eyeY) > 0.03) continue
    front = Math.max(front, p.z * fwd)
    back = Math.min(back, p.z * fwd)
  }
  const centre = new Vector3(0, eyeY, ((front + back) / 2) * fwd)

  // chin: the lowest point of the face on the midline, close behind the tip of the nose
  let nose = -Infinity
  for (const p of headPts) if (Math.abs(p.x) < 0.012 && p.y < eyeY) nose = Math.max(nose, p.z * fwd)
  let chinY = Infinity
  for (const p of headPts) {
    if (Math.abs(p.x) < 0.012 && p.y < eyeY - 0.02 && p.z * fwd > nose - 0.035) chinY = Math.min(chinY, p.y)
  }
  if (!Number.isFinite(chinY)) return null

  const m: HeadMeasure = {
    fwd,
    centre,
    eyeY,
    eyeOuter: Math.max(Math.abs(eyes.min.x), Math.abs(eyes.max.x)),
    browTop: brows.isEmpty() ? eyeY + 0.035 : brows.max.y,
    chinY,
    shoulderY,
  }
  return { m, bones, headPts, torsoPts }
}

/**
 * Build the hijab as a skinned mesh bound to the model's skeleton. `materials` are the plain cloth, then the face
 * band (each optionally followed by its outline, see fabric.withOutlines); pass one surface for no band.
 */
export function buildHijab(
  vrm: VRM,
  parts: Part[],
  skeleton: Skeleton,
  bindMatrix: Matrix4,
  materials: Material[],
  banded: boolean,
  fit: HijabFit = DEFAULT_FIT,
): SkinnedMesh | null {
  const started = performance.now()
  const measured = measure(vrm, parts, skeleton, fit)
  if (!measured) return null
  const { m, bones } = measured
  const C = m.centre
  const fwd = m.fwd
  const headHull = hull(measured.headPts)
  const allHull = hull([...measured.headPts, ...measured.torsoPts])

  // the face opening: a rounded oval seen from the front, widest at the eyes
  const half = m.eyeOuter + fit.cheek
  const top = m.browTop + fit.brow - m.eyeY
  const bottom = m.eyeY - (m.chinY - fit.chin)
  const oval = (x: number, y: number, z: number) => {
    const dx = x - C.x
    const dy = y - C.y
    const dz = (z - C.z) * fwd
    // only the front of the head opens; fade the test out smoothly round the sides so the cloth doesn't crease
    const front = smooth(0.15, 0.45, dz / (Math.hypot(dx, dy, dz) || 1))
    const s = Math.abs(dx / half) ** OVAL + Math.abs(dy / (dy > 0 ? top : bottom)) ** OVAL
    return s / Math.max(front, 1e-3)
  }
  // the hem, by direction round the body: lowest at the front and back, rising to the tops of the shoulders
  const hemY = (x: number, z: number) => {
    const c = Math.cos(Math.atan2(x - C.x, (z - C.z) * fwd))
    return m.shoulderY - fit.front * Math.max(0, c) ** 1.4 - fit.back * Math.max(0, -c) ** 1.4
  }
  const bunDir = new Vector3(0, 0.3, -fwd).normalize()

  const pos: number[] = []
  const at = new Vector3()
  const place = (d: Vector3) => {
    const tDrape = exit(allHull, C, d, fit.ease)
    at.copy(d).multiplyScalar(tDrape).add(C)
    // 0 right at the edge of the face opening, 1 well away from it
    const away = smooth(1, 2, oval(at.x, at.y, at.z))
    // below the chin the cloth hangs from the head to the body, except where it is pinned round the face
    const drape = smooth(m.chinY + 0.03, m.chinY - 0.05, at.y) * away
    const bun = fit.bun * Math.max(0, d.dot(bunDir)) ** 2
    const tHead = drape < 1 ? exit(headHull, C, d, lerp(0.0025, fit.ease + bun, away)) : tDrape
    const t = lerp(tHead, tDrape, drape)
    pos.push(C.x + d.x * t, C.y + d.y * t, C.z + d.z * t)
  }

  // a sphere of directions: the crown, then rings down to nearly straight below
  const NU = 112
  const NV = 92
  const V_MAX = 2.9
  const d = new Vector3()
  place(d.set(0, 1, 0))
  for (let j = 1; j <= NV; j++) {
    const v = (j / NV) * V_MAX
    for (let i = 0; i < NU; i++) {
      const u = (i / NU) * Math.PI * 2
      place(d.set(Math.sin(v) * Math.sin(u), Math.cos(v), fwd * Math.sin(v) * Math.cos(u)))
    }
  }
  const ring = (j: number, i: number) => 1 + (j - 1) * NU + (i % NU)
  // wound to face outward; mirroring z for a VRM 0.x model reverses it
  const tri = (a: number, b: number, c: number, out: number[]) => (fwd > 0 ? out.push(a, b, c) : out.push(a, c, b))
  let index: number[] = []
  for (let i = 0; i < NU; i++) tri(0, ring(1, i), ring(1, i + 1), index)
  for (let j = 1; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const a = ring(j, i)
      const b = ring(j, i + 1)
      const c = ring(j + 1, i + 1)
      const e = ring(j + 1, i)
      tri(a, e, c, index)
      tri(a, c, b, index)
    }
  }

  const split = (a: number, b: number, t: number) => {
    for (let k = 0; k < 3; k++) pos.push(lerp(pos[a * 3 + k], pos[b * 3 + k], t))
    return pos.length / 3 - 1
  }
  const ovalAt = (v: number) => oval(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2])
  let r = cut(index, (v) => pos[v * 3 + 1] - hemY(pos[v * 3], pos[v * 3 + 2]), split)
  index = keep(r.index, r.inside)
  r = cut(index, (v) => ovalAt(v) - 1, split)
  index = keep(r.index, r.inside)
  let plain = index
  let band: number[] = []
  if (banded) {
    const edge = (1 + fit.band) ** OVAL
    r = cut(index, (v) => ovalAt(v) - edge, split)
    plain = keep(r.index, r.inside)
    band = keep(r.index, r.inside, false)
  }

  // keep only the vertices still in use, and skin each one
  const remap = new Map<number, number>()
  const outPos: number[] = []
  const influences: Influences[] = []
  const reindex = (list: number[]) =>
    list.map((v) => {
      let n = remap.get(v)
      if (n === undefined) {
        n = remap.size
        remap.set(v, n)
        const x = pos[v * 3]
        const y = pos[v * 3 + 1]
        const z = pos[v * 3 + 2]
        outPos.push(x, y, z)
        const drape = smooth(m.chinY + 0.02, m.chinY - 0.06, y) * smooth(1, 2.2, oval(x, y, z))
        const t = clamp01((y - m.shoulderY) / (m.chinY - m.shoulderY))
        influences.push(
          normalise([
            [bones.head, 1 - drape + drape * t * t],
            [bones.neck, drape * 2 * t * (1 - t)],
            [bones.chest, drape * (1 - t) * (1 - t)],
          ]),
        )
      }
      return n
    })
  const plainIdx = reindex(plain)
  const bandIdx = reindex(band)
  const all = [...plainIdx, ...bandIdx]

  const geometry = new BufferGeometry()
  const count = outPos.length / 3
  const skin = packInfluences(influences)
  geometry.setAttribute('position', new Float32BufferAttribute(outPos, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array(count * 2), 2))
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skin.index, 4))
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skin.weight, 4))
  geometry.setIndex(count > 65535 ? new Uint32BufferAttribute(all, 1) : new Uint16BufferAttribute(all, 1))
  geometry.computeVertexNormals()
  // built in bind space; the mesh's own vertices are in its local space
  geometry.applyMatrix4(new Matrix4().copy(bindMatrix).invert())
  addGroups(geometry, materials, banded ? [[0, plainIdx.length], [plainIdx.length, bandIdx.length]] : [[0, plainIdx.length]])

  const mesh = new SkinnedMesh(geometry, materials)
  mesh.name = 'Hijab'
  mesh.frustumCulled = false
  mesh.bind(skeleton, bindMatrix)
  mesh.userData.fit = { ...m, ms: Math.round(performance.now() - started), vertices: count, triangles: all.length / 3 }
  return mesh
}
