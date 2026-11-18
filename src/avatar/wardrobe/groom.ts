// Grooming a stand-in's head: short hair and a trimmed beard grown from the head's own skin (see shell.ts), heavier
// brows, and eyelid shapes held a little closed. Every line is measured from the model's own face (its eyes and brows,
// the mouth its "aa" expression opens, its chin and ears), so it fits any VRoid-built head.

import { VRMExpressionMorphTargetBind, type VRM } from '@pixiv/three-vrm'
import type { Mesh, Skeleton } from 'three'
import type { ShellSpec, ShellVertex } from './shell'
import { boneSet, weightIn, type Part } from './skinning'

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const DEG = 180 / Math.PI

/** Landmarks of a head in bind space (m), and the parts of the model they were read from. */
export interface Face {
  /** +1 when the face looks along +z in bind space (VRM 1.0), -1 when it looks along -z (VRM 0.x) */
  fwd: number
  /** z of the upright axis through the ears; angles round the head are measured about it */
  axisZ: number
  eyeY: number
  browTop: number
  noseTipY: number
  mouthY: number
  /** half the mouth's width, and how far round the head its corners sit (degrees from straight ahead) */
  mouthHalf: number
  cornerAngle: number
  chinY: number
  earTop: number
  earBottom: number
  /** the face's skin (with its expression morphs), the scalp under the hair, and the brows */
  skin: Part
  scalp: Part[]
  brows: Part[]
}

/** Where the sideburns end, a third of the way up the ear: the hair comes down to here and the beard up to it. */
const sideburnY = (f: Face) => lerp(f.earBottom, f.earTop, 0.35)

/** How far round the head a point is: 0 straight ahead, 90 at the ears, 180 straight behind (degrees). */
export function around(f: Face, v: { x: number; z: number }) {
  return Math.atan2(Math.abs(v.x), (v.z - f.axisZ) * f.fwd) * DEG
}

const points = (p: Part) => Array.from({ length: p.pos.length / 3 }, (_, i) => i)

/** Read the head's landmarks, or null if this isn't a face built the way VRoid builds them. */
export function measureFace(vrm: VRM, parts: Part[], skeleton: Skeleton): Face | null {
  const fwd = vrm.meta.metaVersion === '0' ? -1 : 1
  const named = (re: RegExp) => parts.filter((p) => re.test(p.material.name))
  const X = (p: Part, i: number) => p.pos[i * 3]
  const Y = (p: Part, i: number) => p.pos[i * 3 + 1]
  const Z = (p: Part, i: number) => p.pos[i * 3 + 2]

  // the face skin proper reaches the middle of the face; the ears are skin of their own, off to the sides
  const faceSkins = named(/Face_\d+_SKIN/)
  const onMidline = (p: Part) => points(p).filter((i) => Math.abs(X(p, i)) < 0.004)
  const skin = faceSkins.filter((p) => onMidline(p).length).sort((a, b) => b.pos.length - a.pos.length)[0]
  const eyes = named(/EyeWhite/)
  if (!skin || !eyes.length) return null
  const ears = faceSkins.filter((p) => p !== skin && !onMidline(p).length)
  const brows = named(/FaceBrow/)

  const mean = (vals: number[]) => vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length)
  const eyeY = mean(eyes.flatMap((p) => points(p).map((i) => Y(p, i))))
  const browTop = brows.length ? Math.max(...brows.flatMap((p) => points(p).map((i) => Y(p, i)))) : eyeY + 0.04
  const mid = onMidline(skin)
  const chinY = Math.min(...mid.map((i) => Y(skin, i)))
  const nose = mid.filter((i) => Y(skin, i) < eyeY - 0.01).sort((a, b) => Z(skin, b) * fwd - Z(skin, a) * fwd)[0]
  const noseTipY = nose !== undefined ? Y(skin, nose) : lerp(eyeY, chinY, 0.4)

  const earPts = ears.flatMap((p) => points(p).map((i) => [Y(p, i), Z(p, i)]))
  const earTop = earPts.length ? Math.max(...earPts.map((e) => e[0])) : eyeY + 0.02
  const earBottom = earPts.length ? Math.min(...earPts.map((e) => e[0])) : eyeY - 0.035
  const axisZ = earPts.length ? mean(earPts.map((e) => e[1])) : mean(points(skin).map((i) => Z(skin, i)))

  // the mouth is where the "aa" expression moves the skin most; its corners are where it still moves a quarter as much
  let mouthY = lerp(noseTipY, chinY, 0.4)
  let mouthHalf = 0.025
  let corner = { x: mouthHalf, z: 0 }
  const aa = vrm.expressionManager?.getExpression('aa')
  const bind = aa?.binds.find((b): b is VRMExpressionMorphTargetBind => b instanceof VRMExpressionMorphTargetBind && b.primitives.includes(skin.mesh))
  const offsets = bind ? skin.mesh.geometry.morphAttributes.position?.[bind.index] : undefined
  if (offsets) {
    const moved = points(skin).map((i) => Math.hypot(offsets.getX(i), offsets.getY(i), offsets.getZ(i)))
    const most = Math.max(...moved)
    if (most > 0) {
      mouthY = mean(points(skin).filter((i) => moved[i] > most * 0.6).map((i) => Y(skin, i)))
      const lips = points(skin).filter((i) => moved[i] > most * 0.25 && Math.abs(Y(skin, i) - mouthY) < 0.006)
      const c = lips.sort((a, b) => Math.abs(X(skin, b)) - Math.abs(X(skin, a)))[0]
      if (c !== undefined) {
        mouthHalf = Math.abs(X(skin, c))
        corner = { x: mouthHalf, z: Z(skin, c) }
      }
    }
  }

  // the scalp: skin the head carries that isn't the face (VRoid paints it the hair's colour)
  const head = boneSet(skeleton, [vrm.humanoid?.getRawBoneNode('head') ?? null])
  const scalp = named(/_SKIN/).filter((p) => !/Face/.test(p.material.name) && mean(Array.from(weightIn(p.mesh.geometry, head))) > 0.5)

  const f: Face = {
    fwd, axisZ, eyeY, browTop, noseTipY, mouthY, mouthHalf, cornerAngle: 0, chinY, earTop, earBottom, skin, scalp, brows,
  }
  f.cornerAngle = around(f, corner)
  return f
}

export interface HairFit {
  /** forehead from the top of the brows to the hairline (m) */
  forehead: number
  /** thickness over the crown and over the ears, and the extra swept up at the front (m) */
  top: number
  sides: number
  lift: number
}

export const HAIR_FIT: HairFit = { forehead: 0.042, top: 0.008, sides: 0.0035, lift: 0.006 }

/** A short back and sides: across the forehead, down the sideburns, over the ears, down to the nape. */
export function hairSpec(f: Face, fit: HairFit): ShellSpec {
  const front = f.browTop + fit.forehead
  const temple = front + 0.006
  const sideburn = sideburnY(f)
  const overEar = f.earTop + 0.008
  const nape = f.earBottom - 0.012
  // the hairline's height at each angle round the head
  const line = (a: number) => {
    if (a < 28) return front
    if (a < 46) return lerp(front, temple, smooth(28, 46, a))
    // round the temple and down in front of the ear
    if (a < 74) return lerp(temple, sideburn, smooth(46, 74, a))
    if (a < 82) return sideburn
    if (a < 92) return lerp(sideburn, overEar, smooth(82, 92, a))
    if (a < 112) return overEar
    return lerp(overEar, nape, smooth(112, 135, a))
  }
  const above = (v: ShellVertex) => v.y - line(around(f, v))
  return {
    name: 'Hair',
    keep: [above, (v) => v.head - 0.5],
    ease: (v) => {
      const a = around(f, v)
      let e = lerp(fit.sides, fit.top, smooth(f.earTop, f.browTop + 0.07, v.y))
      e += fit.lift * (1 - smooth(25, 70, a)) * smooth(front - 0.005, front + 0.03, v.y)
      // thinning to nothing at the hairline, so it grows out of the skin instead of sitting on it like a cap
      return e * lerp(0.25, 1, smooth(0, 0.012, above(v)))
    },
  }
}

export interface BeardFit {
  /** thickness on the cheeks and lip, on the jaw, and extra at the point of the chin (m) */
  cheeks: number
  jaw: number
  chin: number
}

export const BEARD_FIT: BeardFit = { cheeks: 0.0026, jaw: 0.0042, chin: 0.0025 }

/** A trimmed full beard: moustache, chin and jaw, up the cheeks to the sideburns, the lips left clear. */
export function beardSpec(f: Face, fit: BeardFit): ShellSpec {
  const underNose = lerp(f.noseTipY, f.mouthY, 0.38)
  const sideburn = sideburnY(f)
  // the cheek line: level under the nose, staying low across the cheek, rising to the sideburns only near the ear
  const cheek = (a: number) => lerp(underNose, sideburn, smooth(f.cornerAngle + 4, 76, a) ** 1.8)
  const below = (v: ShellVertex) => cheek(around(f, v)) - v.y
  const lips = (v: ShellVertex) => {
    const dy = v.y - f.mouthY
    return (v.x / (f.mouthHalf + 0.003)) ** 2 + (dy / (dy > 0 ? 0.0028 : 0.0045)) ** 2 - 1
  }
  return {
    name: 'Beard',
    keep: [below, lips, (v) => 88 - around(f, v)],
    ease: (v) => {
      const a = around(f, v)
      let e = lerp(fit.cheeks, fit.jaw, smooth(f.mouthY, f.mouthY - 0.02, v.y))
      e += fit.chin * smooth(f.chinY + 0.025, f.chinY, v.y) * (1 - smooth(20, 45, a))
      // thinning out to the cheek line (over a shorter run on the moustache) and to the lips
      const edge = smooth(0, lerp(0.003, 0.008, smooth(15, 40, a)), below(v)) * smooth(0, 0.8, lips(v))
      return Math.max(0.0006, e * lerp(0.2, 1, edge))
    },
  }
}

/** Heavier brows: each one stretched away from its own centre line, and its expressions with it. */
export function thickenBrows(brows: Part[], factor: number) {
  for (const p of brows) {
    const g = p.mesh.geometry
    const pos = g.getAttribute('position')
    const n = pos.count
    // the centre line: the mean height of the brow at about the same x (the top and bottom edges of the strip)
    const mid = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      let count = 0
      for (let j = 0; j < n; j++) {
        if (Math.abs(pos.getX(j) - pos.getX(i)) < 0.003) {
          sum += pos.getY(j)
          count++
        }
      }
      mid[i] = sum / count
    }
    for (let i = 0; i < n; i++) pos.setY(i, mid[i] + (pos.getY(i) - mid[i]) * factor)
    pos.needsUpdate = true
    for (const m of g.morphAttributes.position ?? []) {
      for (let i = 0; i < n; i++) m.setY(i, m.getY(i) * factor)
      m.needsUpdate = true
    }
  }
}

/**
 * Hold face morphs at fixed weights: shapes no expression drives (an expression would reset its own morphs every
 * frame, so those are left alone).
 */
export function holdMorphs(vrm: VRM, held: [number, number][]) {
  const driven = new Set<string>()
  for (const e of vrm.expressionManager?.expressions ?? []) {
    for (const b of e.binds) {
      if (b instanceof VRMExpressionMorphTargetBind) for (const m of b.primitives) driven.add(`${m.uuid}:${b.index}`)
    }
  }
  vrm.scene.traverse((o) => {
    const m = o as Mesh
    if (!m.morphTargetInfluences) return
    for (const [k, w] of held) if (k < m.morphTargetInfluences.length && !driven.has(`${m.uuid}:${k}`)) m.morphTargetInfluences[k] = w
  })
}
