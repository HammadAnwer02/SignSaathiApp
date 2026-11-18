// Reading a VRM's skinned meshes: which bones weigh on each vertex, and where things sit in the bind (T) pose.

import { Matrix4, Vector3, type BufferGeometry, type Material, type Object3D, type Skeleton, type SkinnedMesh } from 'three'
import type { VRM } from '@pixiv/three-vrm'

/** One skinned primitive of the model, with its surface material and bind-pose vertex positions. */
export interface Part {
  mesh: SkinnedMesh
  material: Material
  /** xyz per vertex, bind space (shared by every part of the model) */
  pos: Float32Array
}

export function partsOf(vrm: VRM): Part[] {
  const parts: Part[] = []
  vrm.scene.traverse((o) => {
    const mesh = o as SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const src = mesh.geometry.getAttribute('position')
    const pos = new Float32Array(src.count * 3)
    const v = new Vector3()
    for (let i = 0; i < src.count; i++) {
      v.fromBufferAttribute(src, i).applyMatrix4(mesh.bindMatrix)
      v.toArray(pos, i * 3)
    }
    parts.push({ mesh, material, pos })
  })
  return parts
}

/** Indices (into skeleton.bones) of the given bones and everything below them, stopping at `stops`. */
export function boneSet(skeleton: Skeleton, roots: (Object3D | null)[], stops: (Object3D | null)[] = []): Set<number> {
  const set = new Set<number>()
  const stop = new Set(stops.filter((s): s is Object3D => !!s))
  const visit = (o: Object3D) => {
    if (stop.has(o)) return
    const i = skeleton.bones.indexOf(o as (typeof skeleton.bones)[number])
    if (i >= 0) set.add(i)
    o.children.forEach(visit)
  }
  for (const r of roots) if (r) visit(r)
  return set
}

/** Per vertex, how much of its skinning comes from the bones in `set` (0..1). */
export function weightIn(geometry: BufferGeometry, set: Set<number>): Float32Array {
  const si = geometry.getAttribute('skinIndex')
  const sw = geometry.getAttribute('skinWeight')
  const out = new Float32Array(si.count)
  for (let v = 0; v < si.count; v++) {
    let s = 0
    for (let k = 0; k < 4; k++) if (set.has(si.getComponent(v, k))) s += sw.getComponent(v, k)
    out[v] = s
  }
  return out
}

/**
 * Bones that move with one arm: everything hanging off the collarbone except the collarbone itself. Helper bones
 * often sit there rather than under the upper arm (twist bones, a sleeve's cloth bones). Without a collarbone,
 * the upper arm and everything below it.
 */
export function armBones(skeleton: Skeleton, shoulder: Object3D | null, upperArm: Object3D | null): Set<number> {
  const set = boneSet(skeleton, [shoulder ?? upperArm])
  if (shoulder) set.delete(skeleton.bones.indexOf(shoulder as (typeof skeleton.bones)[number]))
  return set
}

/** Where a bone sits in the bind pose. */
export function bindPosition(skeleton: Skeleton, bone: Object3D | null): Vector3 | null {
  const i = bone ? skeleton.bones.indexOf(bone as (typeof skeleton.bones)[number]) : -1
  if (i < 0) return null
  return new Vector3().setFromMatrixPosition(new Matrix4().copy(skeleton.boneInverses[i]).invert())
}

/** Up to four bone influences, heaviest first, summing to 1. */
export type Influences = [number, number][]

export function influencesOf(geometry: BufferGeometry, v: number): Influences {
  const si = geometry.getAttribute('skinIndex')
  const sw = geometry.getAttribute('skinWeight')
  const out: Influences = []
  for (let k = 0; k < 4; k++) {
    const w = sw.getComponent(v, k)
    if (w > 0) out.push([si.getComponent(v, k), w])
  }
  return out
}

/** Blend two vertices' influences (t = 0 gives a, 1 gives b), keeping the four heaviest. */
export function blendInfluences(a: Influences, b: Influences, t: number): Influences {
  const sum = new Map<number, number>()
  for (const [i, w] of a) sum.set(i, (sum.get(i) ?? 0) + w * (1 - t))
  for (const [i, w] of b) sum.set(i, (sum.get(i) ?? 0) + w * t)
  return normalise([...sum])
}

export function normalise(list: Influences): Influences {
  const top = list.filter(([, w]) => w > 1e-4).sort((x, y) => y[1] - x[1]).slice(0, 4)
  const total = top.reduce((s, [, w]) => s + w, 0) || 1
  return top.map(([i, w]) => [i, w / total])
}

/** Pack influences into skinIndex / skinWeight arrays (4 per vertex). */
export function packInfluences(list: Influences[]): { index: Uint16Array; weight: Float32Array } {
  const index = new Uint16Array(list.length * 4)
  const weight = new Float32Array(list.length * 4)
  list.forEach((inf, v) => {
    inf.forEach(([i, w], k) => {
      index[v * 4 + k] = i
      weight[v * 4 + k] = w
    })
  })
  return { index, weight }
}
