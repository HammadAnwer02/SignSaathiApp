// Close-fitting clothes cut from the body mesh itself: a second skin over part of the body, stood off it by a
// little ease. It keeps the body's skinning and UVs, so it bends and twists exactly as the body does and can be
// printed with a texture laid out like the body's. Cut from a face, it also keeps the face's expression morphs and
// shares their live weights, so a beard opens with the mouth.

import {
  BufferGeometry, Float32BufferAttribute, Matrix4, SkinnedMesh, Uint16BufferAttribute, Uint32BufferAttribute, Vector3,
  type Material, type Skeleton,
} from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import { cut, keep } from './cut'
import { addGroups } from './fabric'
import {
  armBones, blendInfluences, boneSet, influencesOf, packInfluences, weightIn, type Influences, type Part,
} from './skinning'

/** What a cut or the ease can look at for one vertex: bind-pose position and how much each limb moves it. */
export interface ShellVertex {
  x: number
  y: number
  z: number
  /** weight of the arm bones (shoulder helpers to forearm twist), the hand bones, and the head */
  arm: number
  hand: number
  head: number
}

export interface ShellSpec {
  name: string
  /** keep the surface where every one of these is >= 0 */
  keep: ((v: ShellVertex) => number)[]
  /** where this is < 0, use the second material (a cuff or a band) */
  band?: (v: ShellVertex) => number
  /** how far the cloth stands off the skin (m) */
  ease: (v: ShellVertex) => number
}

/** Bone sets a shell's cuts are measured against. */
export function limbs(vrm: VRM, skeleton: Skeleton) {
  const raw = (name: VRMHumanBoneName) => vrm.humanoid?.getRawBoneNode(name) ?? null
  const hand = boneSet(skeleton, [raw('leftHand'), raw('rightHand')])
  const arm = new Set([
    ...armBones(skeleton, raw('leftShoulder'), raw('leftUpperArm')),
    ...armBones(skeleton, raw('rightShoulder'), raw('rightUpperArm')),
  ])
  for (const h of hand) arm.delete(h)
  return { arm, hand, head: boneSet(skeleton, [raw('head')]) }
}

export function buildShell(
  vrm: VRM,
  body: Part,
  skeleton: Skeleton,
  bindMatrix: Matrix4,
  materials: Material[],
  spec: ShellSpec,
): SkinnedMesh | null {
  const g = body.mesh.geometry
  const normals = g.getAttribute('normal')
  const uvs = g.getAttribute('uv')
  if (!g.index || !normals) return null
  const sets = limbs(vrm, skeleton)
  if (!sets.arm.size || !sets.hand.size) return null

  const count = g.getAttribute('position').count
  const pos = Array.from(body.pos)
  const nor: number[] = []
  const uv: number[] = []
  const n = new Vector3()
  for (let v = 0; v < count; v++) {
    n.fromBufferAttribute(normals, v).transformDirection(bindMatrix).toArray(nor, v * 3)
    uv.push(uvs ? uvs.getX(v) : 0, uvs ? uvs.getY(v) : 0)
  }
  const arm = Array.from(weightIn(g, sets.arm))
  const hand = Array.from(weightIn(g, sets.hand))
  const head = Array.from(weightIn(g, sets.head))
  const inf: Influences[] = Array.from({ length: count }, (_, v) => influencesOf(g, v))
  // morph targets (xyz offsets per vertex), position and normal, carried through the cuts like everything else
  const readMorphs = (list: BufferGeometry['morphAttributes']['position']) =>
    (list ?? []).map((a) => {
      const out: number[] = []
      for (let v = 0; v < count; v++) out.push(a.getX(v), a.getY(v), a.getZ(v))
      return out
    })
  const morphPos = readMorphs(g.morphAttributes.position)
  const morphNor = morphPos.length ? readMorphs(g.morphAttributes.normal) : []
  const morphs = [...morphPos, ...morphNor]

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const split = (a: number, b: number, t: number) => {
    for (let k = 0; k < 3; k++) {
      pos.push(lerp(pos[a * 3 + k], pos[b * 3 + k], t))
      nor.push(lerp(nor[a * 3 + k], nor[b * 3 + k], t))
      for (const m of morphs) m.push(lerp(m[a * 3 + k], m[b * 3 + k], t))
    }
    uv.push(lerp(uv[a * 2], uv[b * 2], t), lerp(uv[a * 2 + 1], uv[b * 2 + 1], t))
    arm.push(lerp(arm[a], arm[b], t))
    hand.push(lerp(hand[a], hand[b], t))
    head.push(lerp(head[a], head[b], t))
    inf.push(blendInfluences(inf[a], inf[b], t))
    return arm.length - 1
  }
  const view: ShellVertex = { x: 0, y: 0, z: 0, arm: 0, hand: 0, head: 0 }
  const at = (v: number) => {
    view.x = pos[v * 3]
    view.y = pos[v * 3 + 1]
    view.z = pos[v * 3 + 2]
    view.arm = arm[v]
    view.hand = hand[v]
    view.head = head[v]
    return view
  }

  let index = Array.from(g.index.array)
  for (const field of spec.keep) {
    const r = cut(index, (v) => field(at(v)), split)
    index = keep(r.index, r.inside)
  }
  if (!index.length) return null
  let main = index
  let band: number[] = []
  if (spec.band) {
    const field = spec.band
    const r = cut(index, (v) => field(at(v)), split)
    main = keep(r.index, r.inside)
    band = keep(r.index, r.inside, false)
  }

  const remap = new Map<number, number>()
  const outPos: number[] = []
  const outNor: number[] = []
  const outUv: number[] = []
  const outInf: Influences[] = []
  const outMorphs: number[][] = morphs.map(() => [])
  const reindex = (list: number[]) =>
    list.map((v) => {
      let i = remap.get(v)
      if (i === undefined) {
        i = remap.size
        remap.set(v, i)
        const ease = spec.ease(at(v))
        n.fromArray(nor, v * 3).normalize()
        outPos.push(pos[v * 3] + n.x * ease, pos[v * 3 + 1] + n.y * ease, pos[v * 3 + 2] + n.z * ease)
        outNor.push(n.x, n.y, n.z)
        outUv.push(uv[v * 2], uv[v * 2 + 1])
        outInf.push(inf[v])
        // the cloth rides on the skin: each expression moves it as far as the skin under it
        morphs.forEach((m, k) => outMorphs[k].push(m[v * 3], m[v * 3 + 1], m[v * 3 + 2]))
      }
      return i
    })
  const mainIdx = reindex(main)
  const bandIdx = reindex(band)
  const all = [...mainIdx, ...bandIdx]

  const geometry = new BufferGeometry()
  const vertices = outPos.length / 3
  const skin = packInfluences(outInf)
  geometry.setAttribute('position', new Float32BufferAttribute(outPos, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(outNor, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(outUv, 2))
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skin.index, 4))
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skin.weight, 4))
  geometry.setIndex(vertices > 65535 ? new Uint32BufferAttribute(all, 1) : new Uint16BufferAttribute(all, 1))
  // built in bind space; the mesh's own vertices are in its local space (morph offsets already are)
  geometry.applyMatrix4(new Matrix4().copy(bindMatrix).invert())
  if (morphPos.length) {
    const attrs = (from: number, to: number) => outMorphs.slice(from, to).map((m) => new Float32BufferAttribute(m, 3))
    geometry.morphAttributes.position = attrs(0, morphPos.length)
    if (morphNor.length) geometry.morphAttributes.normal = attrs(morphPos.length, morphs.length)
    geometry.morphTargetsRelative = g.morphTargetsRelative
  }
  addGroups(geometry, materials, band.length ? [[0, mainIdx.length], [mainIdx.length, bandIdx.length]] : [[0, mainIdx.length]])

  const mesh = new SkinnedMesh(geometry, materials)
  mesh.name = spec.name
  mesh.frustumCulled = false
  mesh.bind(skeleton, bindMatrix)
  if (morphPos.length && body.mesh.morphTargetInfluences) {
    // the same weights array as the skin it was cut from, so expressions set on the face move it too
    mesh.morphTargetInfluences = body.mesh.morphTargetInfluences
    mesh.morphTargetDictionary = body.mesh.morphTargetDictionary
  }
  return mesh
}

/** Full sleeves: each arm from under the existing sleeve down to where the hand takes over at the wrist. */
export function sleevesSpec(ease: number): ShellSpec {
  return {
    name: 'Sleeves',
    keep: [(v) => v.arm + v.hand - 0.45, (v) => v.arm - v.hand],
    ease: () => ease,
  }
}
