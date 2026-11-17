// Which avatar bones we drive, how they chain, and what their rest (T-pose) directions are.
// Works on three-vrm *normalized* bones: at rest every bone has identity rotation and its
// local axes line up with the model's axes (VRM 1.0 faces +Z, the avatar's left is +X).

import { Box3, Vector3, type Object3D } from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

export const SIDE_NAMES = ['left', 'right'] as const
export type Side = 0 | 1

const FINGER_PARTS = [
  ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'],
  ['IndexProximal', 'IndexIntermediate', 'IndexDistal'],
  ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'],
  ['RingProximal', 'RingIntermediate', 'RingDistal'],
  ['LittleProximal', 'LittleIntermediate', 'LittleDistal'],
] as const

/** MediaPipe hand landmark chains, one per finger (same order as FINGER_PARTS). */
export const FINGER_LANDMARKS = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
] as const

export const BONES: VRMHumanBoneName[] = ['spine', 'chest', 'neck', 'head']
export const PARENT: number[] = [-1, 0, 1, 2]
/** per side: index of upperArm, lowerArm, hand and the 5x3 finger bones */
export const ARM: { upper: number; lower: number; hand: number; fingers: number[][] }[] = []

for (const side of SIDE_NAMES) {
  const upper = BONES.push(`${side}UpperArm` as VRMHumanBoneName) - 1
  PARENT.push(1)
  const lower = BONES.push(`${side}LowerArm` as VRMHumanBoneName) - 1
  PARENT.push(upper)
  const hand = BONES.push(`${side}Hand` as VRMHumanBoneName) - 1
  PARENT.push(lower)
  const fingers: number[][] = []
  for (const parts of FINGER_PARTS) {
    const chain: number[] = []
    let parent = hand
    for (const part of parts) {
      const i = BONES.push(`${side}${part}` as VRMHumanBoneName) - 1
      PARENT.push(parent)
      chain.push(i)
      parent = i
    }
    fingers.push(chain)
  }
  ARM.push({ upper, lower, hand, fingers })
}

export const SPINE = 0
export const CHEST = 1
export const NECK = 2
export const HEAD = 3
export const BONE_COUNT = BONES.length

export interface Rest {
  nodes: (Object3D | null)[]
  /** rest direction of each bone (towards its child), model space, unit length */
  dir: Vector3[]
  /** per side: index knuckle minus little knuckle at rest (unit) */
  handSide: [Vector3, Vector3]
  /** model-space heights used for camera framing */
  headY: number
  /** highest point of the model (top of the hair) */
  topY: number
  chestY: number
  hipsY: number
  shoulderWidth: number
}

export function measureRest(vrm: VRM): Rest {
  const h = vrm.humanoid
  h.resetNormalizedPose()
  vrm.scene.updateMatrixWorld(true)
  const node = (name: VRMHumanBoneName) => h.getNormalizedBoneNode(name)
  const pos = (name: VRMHumanBoneName): Vector3 | null => {
    const n = node(name)
    return n ? vrm.scene.worldToLocal(n.getWorldPosition(new Vector3())) : null
  }
  const between = (a: VRMHumanBoneName, b: VRMHumanBoneName, fallback: Vector3) => {
    const pa = pos(a)
    const pb = pos(b)
    if (!pa || !pb || pa.distanceToSquared(pb) < 1e-10) return fallback.clone()
    return pb.sub(pa).normalize()
  }

  const up = new Vector3(0, 1, 0)
  const dir: Vector3[] = BONES.map(() => up.clone())
  dir[SPINE] = between('spine', node('chest') ? 'chest' : 'neck', up)
  dir[CHEST] = between('chest', 'neck', up)
  dir[NECK] = between('neck', 'head', up)
  dir[HEAD] = up.clone()

  const handSide: Vector3[] = []
  SIDE_NAMES.forEach((side, s) => {
    const out = new Vector3(s === 0 ? 1 : -1, 0, 0)
    const a = ARM[s]
    dir[a.upper] = between(`${side}UpperArm`, `${side}LowerArm`, out)
    dir[a.lower] = between(`${side}LowerArm`, `${side}Hand`, out)
    dir[a.hand] = between(`${side}Hand`, `${side}MiddleProximal`, out)
    a.fingers.forEach((chain) => {
      for (let k = 0; k < chain.length; k++) {
        const name = BONES[chain[k]]
        const next = k + 1 < chain.length ? BONES[chain[k + 1]] : null
        dir[chain[k]] = next ? between(name, next, dir[k > 0 ? chain[k - 1] : a.hand]) : dir[chain[k - 1]].clone()
      }
    })
    handSide.push(between(`${side}LittleProximal`, `${side}IndexProximal`, new Vector3(0, 0, 1)))
  })

  const y = (name: VRMHumanBoneName, fallback: number) => pos(name)?.y ?? fallback
  const lu = pos('leftUpperArm')
  const ru = pos('rightUpperArm')
  const headY = y('head', 1.4)
  const topY = new Box3().setFromObject(vrm.scene).max.y
  return {
    nodes: BONES.map((b) => node(b)),
    dir,
    handSide: handSide as [Vector3, Vector3],
    headY,
    topY: Number.isFinite(topY) && topY > headY ? topY : headY + 0.2,
    chestY: y('chest', y('spine', 1.1)),
    hipsY: y('hips', 0.9),
    shoulderWidth: lu && ru ? lu.distanceTo(ru) : 0.3,
  }
}
