// Landmarks -> avatar bone rotations.
//
// Each bone gets a world-space rotation that carries its rest direction onto the direction
// measured in the video (plus a second reference vector where twist matters: the elbow's
// bend plane and the palm). Local rotations are then parent^-1 * world. Arms whose hand is
// not signing blend towards a relaxed idle pose using the per-frame weights from the bake.

import { Quaternion, Vector3 } from 'three'
import type { Clip } from '../signs/data'
import { ARM, BONE_COUNT, CHEST, FINGER_LANDMARKS, HEAD, NECK, PARENT, SPINE, type Rest } from './rig'

/** Expressions driven from face blendshapes (VRM preset names). */
export const EXPRESSIONS = ['blink', 'aa', 'ou', 'happy', 'surprised', 'angry', 'sad'] as const
export const EXPR_COUNT = EXPRESSIONS.length

/** A solved clip: local bone quaternions and expression weights for every frame. */
export interface Motion {
  id: string
  frames: number
  fps: number
  /** frames * BONE_COUNT * 4 */
  q: Float32Array
  /** frames * EXPR_COUNT */
  expr: Float32Array
  /** first/last frame where a hand is fully signing (used to trim fingerspelled letters) */
  core: [number, number]
}

// body point ids in the baked clips
const NOSE = 0, L_EAR = 3, R_EAR = 4, L_SH = 5, R_SH = 6, L_EL = 7, R_EL = 8, L_WR = 9, R_WR = 10, L_HIP = 11, R_HIP = 12
const HAND0 = [13, 34]

const X = new Vector3(1, 0, 0)
const Y = new Vector3(0, 1, 0)
const Z = new Vector3(0, 0, 1)
const HEAD_REST_FWD = new Vector3(0, -0.32, 1).normalize()
const IDENTITY = new Quaternion()

// scratch objects (the solver is synchronous and single-threaded)
const va = new Vector3(), vb = new Vector3(), vc = new Vector3(), vd = new Vector3(), ve = new Vector3()
const qa = new Quaternion(), qb = new Quaternion(), qc = new Quaternion(), qd = new Quaternion()
const ma = { a: new Vector3(), b: new Vector3(), c: new Vector3() }

/** Rotation whose columns are (p, s orthogonalised, p x s). */
function basis(p: Vector3, s: Vector3, out: Quaternion): Quaternion {
  const { a, b, c } = ma
  a.copy(p).normalize()
  b.copy(s).addScaledVector(a, -a.dot(s))
  if (b.lengthSq() < 1e-10) {
    b.set(0, 1, 0)
    if (Math.abs(a.y) > 0.9) b.set(1, 0, 0)
    b.addScaledVector(a, -a.dot(b))
  }
  b.normalize()
  c.crossVectors(a, b)
  // quaternion from rotation matrix with columns a, b, c (Shepperd's method)
  const m00 = a.x, m01 = b.x, m02 = c.x, m10 = a.y, m11 = b.y, m12 = c.y, m20 = a.z, m21 = b.z, m22 = c.z
  const tr = m00 + m11 + m22
  if (tr > 0) {
    const s4 = Math.sqrt(tr + 1) * 2
    out.set((m21 - m12) / s4, (m02 - m20) / s4, (m10 - m01) / s4, 0.25 * s4)
  } else if (m00 > m11 && m00 > m22) {
    const s4 = Math.sqrt(1 + m00 - m11 - m22) * 2
    out.set(0.25 * s4, (m01 + m10) / s4, (m02 + m20) / s4, (m21 - m12) / s4)
  } else if (m11 > m22) {
    const s4 = Math.sqrt(1 + m11 - m00 - m22) * 2
    out.set((m01 + m10) / s4, 0.25 * s4, (m12 + m21) / s4, (m02 - m20) / s4)
  } else {
    const s4 = Math.sqrt(1 + m22 - m00 - m11) * 2
    out.set((m02 + m20) / s4, (m12 + m21) / s4, 0.25 * s4, (m10 - m01) / s4)
  }
  return out.normalize()
}

/** World rotation taking the rest frame (restP, restS) onto the target frame (tgtP, tgtS). */
function frameRotation(restP: Vector3, restS: Vector3, tgtP: Vector3, tgtS: Vector3, out: Quaternion) {
  basis(restP, restS, qd)
  basis(tgtP, tgtS, out)
  return out.multiply(qd.invert())
}

/** Twist part of q around a unit axis. */
function twistAround(q: Quaternion, axis: Vector3, out: Quaternion) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z
  out.set(axis.x * d, axis.y * d, axis.z * d, q.w)
  const len = Math.hypot(out.x, out.y, out.z, out.w)
  if (len < 1e-9) return out.identity()
  out.x /= len
  out.y /= len
  out.z /= len
  out.w /= len
  return out
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Limit the angle of a rotation (used to stop impossible wrist bends). */
function clampAngle(q: Quaternion, maxRad: number) {
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w)
  const angle = 2 * Math.acos(Math.min(1, q.w))
  if (angle > maxRad) q.slerp(IDENTITY, 1 - maxRad / angle)
  return q
}

export class Solver {
  private world: Quaternion[] = Array.from({ length: BONE_COUNT }, () => new Quaternion())
  private local: Quaternion[] = Array.from({ length: BONE_COUNT }, () => new Quaternion())
  readonly idle: Quaternion[]

  constructor(private rest: Rest) {
    this.idle = this.computeIdle()
  }

  /** Solve every frame of a clip into local rotations + expressions. */
  solveClip(clip: Clip, fps: number, faceNames: string[]): Motion {
    const q = new Float32Array(clip.frames * BONE_COUNT * 4)
    const expr = new Float32Array(clip.frames * EXPR_COUNT)
    const p: Vector3[] = Array.from({ length: clip.points }, () => new Vector3())
    const faceIdx = (n: string) => faceNames.indexOf(n)
    const fi = Object.fromEntries(
      ['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthSmileLeft', 'mouthSmileRight',
        'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'eyeWideLeft', 'eyeWideRight', 'browDownLeft',
        'browDownRight', 'mouthFrownLeft', 'mouthFrownRight'].map((n) => [n, faceIdx(n)]),
    )
    for (let f = 0; f < clip.frames; f++) {
      const o = f * clip.points * 3
      for (let i = 0; i < clip.points; i++) p[i].set(clip.pts[o + i * 3], clip.pts[o + i * 3 + 1], clip.pts[o + i * 3 + 2])
      this.solveFrame(p, clip.weights[f * 2], clip.weights[f * 2 + 1])
      for (let b = 0; b < BONE_COUNT; b++) {
        const l = this.local[b]
        const k = (f * BONE_COUNT + b) * 4
        q[k] = l.x
        q[k + 1] = l.y
        q[k + 2] = l.z
        q[k + 3] = l.w
      }
      if (clip.faceChannels) {
        const fo = f * clip.faceChannels
        const F = (n: string) => (fi[n] >= 0 ? clip.face[fo + fi[n]] : 0)
        const c01 = (x: number) => Math.min(1, Math.max(0, x))
        const e = f * EXPR_COUNT
        expr[e] = c01(((F('eyeBlinkLeft') + F('eyeBlinkRight')) / 2 - 0.3) / 0.45)
        expr[e + 1] = c01(F('jawOpen') * 1.1) * 0.7
        expr[e + 2] = c01(Math.max(F('mouthFunnel'), F('mouthPucker')) * 1.2) * 0.5
        expr[e + 3] = c01(((F('mouthSmileLeft') + F('mouthSmileRight')) / 2) * 1.3) * 0.5
        expr[e + 4] = c01(F('browInnerUp') * 0.8 + ((F('browOuterUpLeft') + F('browOuterUpRight')) / 2) * 0.6 +
          ((F('eyeWideLeft') + F('eyeWideRight')) / 2) * 0.3) * 0.45
        expr[e + 5] = c01(((F('browDownLeft') + F('browDownRight')) / 2) * 1.4) * 0.4
        expr[e + 6] = c01(((F('mouthFrownLeft') + F('mouthFrownRight')) / 2) * 1.2) * 0.3
      }
    }
    let c0 = -1
    let c1 = -1
    for (let f = 0; f < clip.frames; f++) {
      if (Math.max(clip.weights[f * 2], clip.weights[f * 2 + 1]) >= 0.99) {
        if (c0 < 0) c0 = f
        c1 = f
      }
    }
    const core: [number, number] = c0 < 0 ? [0, clip.frames - 1] : [c0, c1]
    return { id: clip.id, frames: clip.frames, fps, q, expr, core }
  }

  /** Solve one frame of points into this.local. */
  private solveFrame(p: Vector3[], wLeft: number, wRight: number) {
    const W = this.world
    const R = this.rest

    // torso: up from mid-hip to mid-shoulder, left along the shoulder line (damped)
    va.addVectors(p[L_SH], p[R_SH]).multiplyScalar(0.5)
    vb.addVectors(p[L_HIP], p[R_HIP]).multiplyScalar(0.5)
    vc.subVectors(va, vb).normalize().lerp(Y, 0.4).normalize()
    vd.subVectors(p[L_SH], p[R_SH])
    frameRotation(Y, X, vc, vd, qa)
    qa.slerp(IDENTITY, 0.3)
    W[SPINE].copy(IDENTITY).slerp(qa, 0.45)
    W[CHEST].copy(qa)

    // head: ear line and nose direction
    va.addVectors(p[L_EAR], p[R_EAR]).multiplyScalar(0.5)
    vb.subVectors(p[NOSE], va)
    vc.subVectors(p[L_EAR], p[R_EAR])
    frameRotation(X, HEAD_REST_FWD, vc, vb, qb)
    qc.copy(W[CHEST]).slerp(qb, 0.85)
    W[HEAD].copy(qc)
    W[NECK].copy(W[CHEST]).slerp(qc, 0.4)

    for (const s of [0, 1] as const) {
      const a = ARM[s]
      const sh = p[s === 0 ? L_SH : R_SH]
      const el = p[s === 0 ? L_EL : R_EL]
      const wr = p[s === 0 ? L_WR : R_WR]
      const sign = s === 0 ? 1 : -1

      // upper arm: direction + elbow bend plane
      va.subVectors(el, sh).normalize()
      vb.subVectors(wr, el).normalize()
      vc.crossVectors(va, vb)
      const sinBend = vc.length()
      W[a.upper].setFromUnitVectors(R.dir[a.upper], va)
      if (sinBend > 0.06) {
        vd.set(0, -sign, 0)
        frameRotation(R.dir[a.upper], vd, va, vc, qa)
        W[a.upper].slerp(qa, smoothstep(0.06, 0.3, sinBend))
      }

      // forearm swing (twist added below from the palm)
      vd.copy(R.dir[a.lower]).applyQuaternion(W[a.upper])
      qa.setFromUnitVectors(vd, vb)
      W[a.lower].copy(qa).multiply(W[a.upper])

      // palm frame from the hand landmarks
      const h0 = HAND0[s]
      vc.subVectors(p[h0 + 9], p[h0])
      vd.subVectors(p[h0 + 5], p[h0 + 17])
      if (vc.lengthSq() > 1e-8 && vd.lengthSq() > 1e-8) {
        frameRotation(R.dir[a.hand], R.handSide[s], vc, vd, qb)
        // split forearm/wrist twist 50/50 to avoid a candy-wrapper wrist
        qc.copy(W[a.lower]).invert().multiply(qb)
        twistAround(qc, R.dir[a.lower], qd)
        qd.slerp(IDENTITY, 0.5)
        W[a.lower].multiply(qd)
        // keep the wrist bend within a plausible range
        qc.copy(W[a.lower]).invert().multiply(qb)
        clampAngle(qc, (100 * Math.PI) / 180)
        W[a.hand].copy(W[a.lower]).multiply(qc)
      } else {
        W[a.hand].copy(W[a.lower])
      }

      // fingers: swing each bone from where its parent carries it onto the measured direction
      a.fingers.forEach((chain, j) => {
        const lm = FINGER_LANDMARKS[j]
        let parentW = W[a.hand]
        for (let k = 0; k < chain.length; k++) {
          const b = chain[k]
          ve.subVectors(p[h0 + lm[k + 1]], p[h0 + lm[k]])
          if (ve.lengthSq() < 1e-10) {
            W[b].copy(parentW)
          } else {
            ve.normalize()
            vd.copy(R.dir[b]).applyQuaternion(parentW)
            W[b].setFromUnitVectors(vd, ve).multiply(parentW)
          }
          parentW = W[b]
        }
      })
    }

    // world -> local, then blend each arm towards idle by its activity weight
    for (let b = 0; b < BONE_COUNT; b++) {
      const parent = PARENT[b]
      const l = this.local[b]
      if (parent < 0) l.copy(W[b])
      else l.copy(W[parent]).invert().multiply(W[b])
    }
    for (const s of [0, 1] as const) {
      const w = s === 0 ? wLeft : wRight
      const a = ARM[s]
      const bones = [a.upper, a.lower, a.hand, ...a.fingers.flat()]
      for (const b of bones) {
        qa.copy(this.local[b])
        this.local[b].copy(this.idle[b]).slerp(qa, w)
      }
    }
  }

  /** Relaxed standing pose: arms down, palms towards the thighs, fingers softly curled. */
  private computeIdle(): Quaternion[] {
    const R = this.rest
    const W = BONES_W()
    const local = BONES_W()
    for (const s of [0, 1] as const) {
      const a = ARM[s]
      const sign = s === 0 ? 1 : -1
      const upper = new Vector3(0.13 * sign, -1, 0.04).normalize()
      const fore = new Vector3(0.05 * sign, -0.9, 0.38).normalize()
      W[a.upper].setFromUnitVectors(R.dir[a.upper], upper)
      const carried = R.dir[a.lower].clone().applyQuaternion(W[a.upper])
      W[a.lower].setFromUnitVectors(carried, fore).multiply(W[a.upper])
      const handF = fore.clone().add(new Vector3(0, -0.15, -0.05)).normalize()
      frameRotation(R.dir[a.hand], R.handSide[s], handF, Z, W[a.hand])
      const rel = W[a.lower].clone().invert().multiply(W[a.hand])
      const tw = twistAround(rel, R.dir[a.lower], new Quaternion()).slerp(IDENTITY, 0.5)
      W[a.lower].multiply(tw)
      for (const b of [a.upper, a.lower, a.hand]) {
        const parent = PARENT[b]
        local[b].copy(parent === 1 ? IDENTITY : W[parent]).invert().multiply(W[b])
      }
      // soft curl around each finger's rest flexion axis (the knuckle line)
      const curl = [
        [0.1, 0.12, 0.08],
        [0.22, 0.3, 0.18],
        [0.28, 0.36, 0.2],
        [0.32, 0.4, 0.22],
        [0.36, 0.44, 0.24],
      ]
      a.fingers.forEach((chain, j) => {
        chain.forEach((b, k) => {
          const axis = j === 0 ? new Vector3(0, 1, 0) : R.handSide[s]
          local[b].setFromAxisAngle(axis, -sign * curl[j][k])
        })
      })
    }
    return local
  }
}

function BONES_W() {
  return Array.from({ length: BONE_COUNT }, () => new Quaternion())
}
