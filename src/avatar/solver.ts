// Landmarks -> avatar bone rotations.
//
// Each bone gets a world-space rotation that carries its rest direction onto the direction
// measured in the video (plus a second reference vector where twist matters: the elbow's
// bend plane and the palm). Local rotations are then parent^-1 * world. Arms whose hand is
// not signing blend towards a relaxed idle pose using the per-frame weights from the bake.
//
// Hand tracking from video often gets fingers wrong (blurred fast moves, fingers hidden in a fist), so finger
// joints are kept to what a hand can do (the middle and end joints only bend like hinges) and a finger bone that
// jumps away from its neighbouring frames for a moment is put back where they agree.
//
// The thumb's two outer joints are hinges too. Aiming its bones only sets their direction, not how the thumb is
// turned about its own length, and the hinges then bend it sideways. So the thumb is turned until its hinges line
// up with the way the tracked thumb bends, smoothed over nearby frames so that it can't twitch.

import { Quaternion, Vector3 } from 'three'
import type { Clip } from '../signs/data'
import { ARM, BONE_COUNT, CHEST, CLIP_POINT, FINGER_LANDMARKS, HEAD, NECK, PARENT, SPINE, type Rest } from './rig'
import { armBody, keepArmsApart, type ArmBody } from './contact'

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
const NOSE = 0, L_EAR = 3, R_EAR = 4, L_HIP = 11, R_HIP = 12
const [L_SH, R_SH] = CLIP_POINT.shoulder
const [L_EL, R_EL] = CLIP_POINT.elbow
const [L_WR, R_WR] = CLIP_POINT.wrist
const HAND0 = CLIP_POINT.hand

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

const RAD = Math.PI / 180

/**
 * How far each finger joint may move, in degrees: bend towards the palm (negative = bent back), and spread
 * sideways from its rest direction. Knuckle (MCP), middle (PIP) and end (DIP) joints; the middle and end joints are
 * hinges, so they barely spread at all.
 */
const FINGER_RANGE = [
  { flex: [-20, 95], spread: 25 },
  { flex: [-5, 110], spread: 3 },
  { flex: [-10, 90], spread: 3 },
] as const

/** The thumb's knuckle (MCP) and end (IP) joints: hinges that bend towards the pad, with a little give sideways. */
const THUMB_RANGE = [
  { flex: [-15, 65], spread: 12 },
  { flex: [-20, 85], spread: 5 },
] as const

/**
 * Which way the thumbnail faces in the rest (T) pose: this far round from the back of the hand, about the thumb,
 * towards the wrist. Measured on the current signers (MakeHuman hands; 0 would be a nail facing up like the
 * fingernails). It sets the thumb's hinge axis.
 */
const THUMB_NAIL_TURN = 75 * Math.PI / 180

/** The furthest the thumb's first bone may swing from where it points at rest (only failed tracking goes further). */
const THUMB_CONE = 80 * Math.PI / 180

/** The furthest the hand may bend at the wrist, whichever way (its turn about itself is left to the twist split). */
const WRIST_BEND = 85 * Math.PI / 180

/** Past this bend from the forearm line the hand's turn about the forearm is too unsure to read (see planTwist). */
const TWIST_READ_BEND = 115 * Math.PI / 180

/** Thumb twist smoothing: frames either side (Gaussian sigma), and how bent the thumb must be to count. */
const TWIST_SIGMA = 3
const TWIST_BEND = [0.15, 0.45] as const

/** One finger joint, in its parent bone's frame (where every bone rests with identity rotation). */
export interface Joint {
  /** the parent bone's direction */
  u: Vector3
  /** the knuckle line (the hinge axis), perpendicular to u */
  a: Vector3
  /** the way the joint bends, towards the palm: a x u, perpendicular to both */
  w: Vector3
  /** allowed bend and spread, radians */
  flex: [number, number]
  spread: [number, number]
}

/** Keep a bone's direction t (unit, in its parent's frame) within its joint's range. Changes and returns t. */
export function limitJoint(t: Vector3, j: Joint): Vector3 {
  const spread = Math.asin(Math.min(1, Math.max(-1, t.dot(j.a))))
  const flex = Math.atan2(t.dot(j.w), t.dot(j.u))
  // Video tracking can't always tell a finger bent towards the camera from one bent away, so a joint bent back past
  // its limit is mirrored about the limit: a little past it stays near straight, far past it (a fist seen with the
  // depth flipped) bends forward about as far. Mirroring, rather than a cut-off, keeps the motion continuous.
  let f = flex < j.flex[0] ? 2 * j.flex[0] - flex : flex
  f = Math.min(j.flex[1], f)
  const s = Math.min(j.spread[1], Math.max(j.spread[0], spread))
  if (s === spread && f === flex) return t
  const c = Math.cos(s)
  return t.copy(j.u).multiplyScalar(c * Math.cos(f)).addScaledVector(j.w, c * Math.sin(f)).addScaledVector(j.a, Math.sin(s))
}

/** Keep a direction t (unit) within maxRad of axis (unit). Changes and returns t. */
export function limitCone(t: Vector3, axis: Vector3, maxRad: number): Vector3 {
  const c = t.dot(axis)
  if (c >= Math.cos(maxRad)) return t
  tv.copy(t).addScaledVector(axis, -c)
  if (tv.lengthSq() < 1e-12) tv.set(1, 0, 0).addScaledVector(axis, -axis.x)
  tv.normalize()
  return t.copy(axis).multiplyScalar(Math.cos(maxRad)).addScaledVector(tv, Math.sin(maxRad))
}

const tv = new Vector3(), tn = new Vector3(), tc = new Vector3()

/**
 * How far the thumb must turn about its first bone (d1) to bring its hinge axis onto the axis the tracked thumb
 * bends about (from d1, d2, d3, its three bones' directions), and how much to trust that: [radians, 0..1].
 * The angle is only known up to a half turn, since the same bend could be a curl or the thumb bent back.
 */
export function bendTwist(d1: Vector3, d2: Vector3, d3: Vector3, hinge: Vector3, out: [number, number]) {
  tn.crossVectors(d1, d2).add(tc.crossVectors(d2, d3))
  tn.addScaledVector(d1, -d1.dot(tn))
  const bend = tn.length()
  if (bend < 1e-6) {
    out[0] = 0
    out[1] = 0
    return out
  }
  tn.divideScalar(bend)
  out[0] = Math.atan2(tc.crossVectors(hinge, tn).dot(d1), hinge.dot(tn))
  out[1] = smoothstep(TWIST_BEND[0], TWIST_BEND[1], bend)
  return out
}

/**
 * Smooth each frame's thumb twist (from bendTwist) over the clip. Nearby frames are averaged as axes (angles
 * doubled, weighted by trust), so a curl and a bent-back reading agree; each frame then takes the half turn nearest
 * the frame before, so the thumb never flips over, and never turns more than a quarter turn from plain aiming. Where
 * the thumb is straight there is nothing to go on, and the twist eases back to plain aiming.
 */
export function smoothTwist(raw: ArrayLike<number>, trust: ArrayLike<number>, sigma = TWIST_SIGMA): Float32Array {
  const n = raw.length
  const out = new Float32Array(n)
  // the twist is read over sigma; how much there is to go on, over twice that, so it eases in and out gently
  const reach = Math.ceil(6 * sigma)
  let last = 0
  for (let f = 0; f < n; f++) {
    let zx = 0
    let zy = 0
    let all = 0
    let seen = 0
    for (let k = Math.max(0, f - reach); k <= Math.min(n - 1, f + reach); k++) {
      const g = Math.exp(-0.5 * ((k - f) / sigma) ** 2) * trust[k]
      const wide = Math.exp(-0.125 * ((k - f) / sigma) ** 2)
      all += wide
      seen += wide * trust[k]
      zx += g * Math.cos(2 * raw[k])
      zy += g * Math.sin(2 * raw[k])
    }
    let m = last
    if (zx * zx + zy * zy > 1e-12) {
      m = Math.atan2(zy, zx) / 2
      m += Math.PI * Math.round((last - m) / Math.PI)
      m = Math.min(Math.PI / 2, Math.max(-Math.PI / 2, m))
    }
    last = smoothstep(0.02, 0.6, seen / all) * m
    out[f] = last
  }
  return out
}

const TURN = 2 * Math.PI

/**
 * How far to turn each frame's hand about the forearm (radians; half goes to the forearm, half to the wrist), from
 * the turn read off each frame (known only up to whole turns; NaN where there was no hand, or none a wrist could make)
 * and the arm's weight.
 * Taking the nearest reading frame by frame would let the forearm snap half round wherever the turn passes half a
 * revolution, as it does with the palm up. Instead the turn is kept continuous from frame to frame, the whole clip
 * is moved by whole turns so the signing frames sit as near the forearm's resting turn as they can, and the turn is
 * held before and after the signing frames, where the arm is easing to rest and the hand's turn comes from the body
 * tracker, which can spin about.
 */
export function planTwist(read: ArrayLike<number>, weight: ArrayLike<number>): Float32Array {
  const n = read.length
  const out = new Float32Array(n)
  // one continuous turn through the readings; frames without one (NaN) go straight across from the reading before
  // to the one after, and are held before the first and after the last
  let prev = -1
  for (let f = 0; f < n; f++) {
    let t = read[f]
    if (!Number.isFinite(t)) continue
    if (prev >= 0) t += TURN * Math.round((out[prev] - t) / TURN)
    out[f] = t
    for (let g = prev + 1; g < f; g++) out[g] = prev < 0 ? t : out[prev] + ((t - out[prev]) * (g - prev)) / (f - prev)
    prev = f
  }
  for (let g = prev + 1; g < n; g++) out[g] = prev < 0 ? 0 : out[prev]
  let a = -1
  let b = -1
  for (let f = 0; f < n; f++) {
    if (weight[f] >= 0.99) {
      if (a < 0) a = f
      b = f
    }
  }
  if (a < 0) [a, b] = [0, n - 1]
  let sum = 0
  for (let f = a; f <= b; f++) sum += out[f]
  const shift = TURN * Math.round(sum / (b - a + 1) / TURN)
  for (let f = a; f <= b; f++) out[f] -= shift
  for (let f = 0; f < a; f++) out[f] = out[a]
  for (let f = b + 1; f < n; f++) out[f] = out[b]
  return out
}

/**
 * Replace one bone's rotation in the flagged frames (skip[f] = 1) by turning evenly from the frame before each run of
 * them to the frame after (held from the one there is, at the clip's ends). q: frames * BONE_COUNT * 4.
 */
export function bridge(q: Float32Array, frames: number, bone: number, skip: ArrayLike<number>) {
  const at = (f: number, out: Quaternion) => {
    const k = (f * BONE_COUNT + bone) * 4
    return out.set(q[k], q[k + 1], q[k + 2], q[k + 3])
  }
  for (let f = 0; f < frames; f++) {
    if (!skip[f]) continue
    let e = f
    while (e + 1 < frames && skip[e + 1]) e++
    const before = f - 1
    const after = e + 1 < frames ? e + 1 : -1
    if (before >= 0 || after >= 0) {
      at(before >= 0 ? before : after, bq0)
      at(after >= 0 ? after : before, bq1)
      for (let g = f; g <= e; g++) {
        bq2.copy(bq0).slerp(bq1, before >= 0 && after >= 0 ? (g - before) / (after - before) : 0)
        q.set([bq2.x, bq2.y, bq2.z, bq2.w], (g * BONE_COUNT + bone) * 4)
      }
    }
    f = e
  }
}

const bq0 = new Quaternion(), bq1 = new Quaternion(), bq2 = new Quaternion()

/** Frames either side that a finger bone is compared with, and how far it may stray from them. */
const SPIKE_HALF = 3
const SPIKE_MIN = 15 * RAD
const SPIKE_SCALE = 3 * 1.4826

function median(a: number[]) {
  a.sort((x, y) => x - y)
  const n = a.length
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2
}

/**
 * Put back the frames where one bone's rotation jumps away from its neighbours (a Hampel filter on rotations).
 * Each frame is compared with the component-wise median of the 7 frames around it, and replaced by that median
 * when it is further from it than 15 deg and than about 4.4 times the window's median distance. Steady moves,
 * quick handshape changes and wiggling fingers pass; a glitch lasting up to 3 frames doesn't.
 * q: frames * stride * 4 local rotations, changed in place.
 */
export function despike(q: Float32Array, frames: number, bone: number, stride = BONE_COUNT) {
  if (frames < 5) return
  // the bone's track, each rotation on the w >= 0 side so they compare component by component
  const tr = new Float64Array(frames * 4)
  for (let f = 0; f < frames; f++) {
    const k = (f * stride + bone) * 4
    const sgn = q[k + 3] < 0 ? -1 : 1
    for (let i = 0; i < 4; i++) tr[f * 4 + i] = sgn * q[k + i]
  }
  const win: number[] = []
  const dist: number[] = []
  const med = [0, 0, 0, 0]
  const fixes: [number, number[]][] = []
  const away = (f: number) =>
    2 * Math.acos(Math.min(1, Math.abs(tr[f * 4] * med[0] + tr[f * 4 + 1] * med[1] + tr[f * 4 + 2] * med[2] + tr[f * 4 + 3] * med[3])))
  for (let f = 0; f < frames; f++) {
    const lo = Math.max(0, f - SPIKE_HALF)
    const hi = Math.min(frames - 1, f + SPIKE_HALF)
    for (let i = 0; i < 4; i++) {
      win.length = 0
      for (let g = lo; g <= hi; g++) win.push(tr[g * 4 + i])
      med[i] = median(win)
    }
    const len = Math.hypot(med[0], med[1], med[2], med[3])
    if (len < 1e-9) continue
    for (let i = 0; i < 4; i++) med[i] /= len
    dist.length = 0
    for (let g = lo; g <= hi; g++) dist.push(away(g))
    if (away(f) > Math.max(SPIKE_MIN, SPIKE_SCALE * median(dist))) fixes.push([f, med.slice()])
  }
  // written after the pass, so every frame was judged against the original track
  for (const [f, m] of fixes) q.set(m, (f * stride + bone) * 4)
}

export class Solver {
  private world: Quaternion[] = Array.from({ length: BONE_COUNT }, () => new Quaternion())
  private local: Quaternion[] = Array.from({ length: BONE_COUNT }, () => new Quaternion())
  readonly idle: Quaternion[]
  /** per bone: its finger or thumb joint's range, or null (every other bone) */
  private joints: (Joint | null)[]
  /** per side: the thumb's hinge axis at rest */
  private thumbHinge: [Vector3, Vector3] = [new Vector3(), new Vector3()]
  /** per side: how far to turn the thumb about its first bone this frame (set by solveClip) */
  private thumbTwist = [0, 0]
  /** per side: the twist and trust bendTwist read off this frame's tracked thumb (written by solveFrame) */
  private thumbBend: [number, number][] = [[0, 0], [0, 0]]
  /** per side: the hand's turn about the forearm read off this frame (radians; written by solveFrame) */
  private twistRead = [0, 0]
  /** per side: whether this frame's tracked hand is bent back further than a wrist goes (written by solveFrame) */
  private bentBack = [false, false]
  /** per side: the turn to give each frame of the clip being solved (planTwist), or null to take each reading */
  private twistPlan: (Float32Array | null)[] = [null, null]
  /** the frame solveFrame is solving */
  private frame = 0
  /** the signer's arms as capsules, to keep them out of each other */
  private body: ArmBody

  constructor(private rest: Rest) {
    this.idle = this.computeIdle()
    this.joints = this.computeJoints()
    this.body = armBody(rest)
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
    const load = (f: number) => {
      const o = f * clip.points * 3
      for (let i = 0; i < clip.points; i++) p[i].set(clip.pts[o + i * 3], clip.pts[o + i * 3 + 1], clip.pts[o + i * 3 + 2])
    }
    // first pass: which way the tracked thumbs bend, frame by frame; smoothed into each frame's thumb twist
    // and how the hands turn about the forearms, planned over the whole clip
    const raw = [new Float32Array(clip.frames), new Float32Array(clip.frames)]
    const trust = [new Float32Array(clip.frames), new Float32Array(clip.frames)]
    const turns = [new Float32Array(clip.frames), new Float32Array(clip.frames)]
    const armWeight = [new Float32Array(clip.frames), new Float32Array(clip.frames)]
    const bent = [new Uint8Array(clip.frames), new Uint8Array(clip.frames)]
    this.thumbTwist[0] = this.thumbTwist[1] = 0
    this.twistPlan = [null, null]
    for (let f = 0; f < clip.frames; f++) {
      load(f)
      this.frame = f
      this.solveFrame(p, clip.weights[f * 2], clip.weights[f * 2 + 1])
      for (const s of [0, 1] as const) {
        raw[s][f] = this.thumbBend[s][0]
        trust[s][f] = this.thumbBend[s][1] * clip.weights[f * 2 + s]
        turns[s][f] = this.twistRead[s]
        armWeight[s][f] = clip.weights[f * 2 + s]
        bent[s][f] = this.bentBack[s] ? 1 : 0
      }
    }
    const twist = [smoothTwist(raw[0], trust[0]), smoothTwist(raw[1], trust[1])]
    this.twistPlan = [planTwist(turns[0], armWeight[0]), planTwist(turns[1], armWeight[1])]
    for (let f = 0; f < clip.frames; f++) {
      load(f)
      this.frame = f
      this.thumbTwist[0] = twist[0][f]
      this.thumbTwist[1] = twist[1][f]
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
    // hands bent back past what a wrist can do: turned evenly from the frame before to the frame after instead
    for (const s of [0, 1] as const) bridge(q, clip.frames, ARM[s].hand, bent[s])
    // fingers: put back frames that jump away from their neighbours, then ease each hand to rest by its weight
    for (const s of [0, 1] as const) {
      for (const b of ARM[s].fingers.flat()) {
        despike(q, clip.frames, b)
        for (let f = 0; f < clip.frames; f++) {
          const k = (f * BONE_COUNT + b) * 4
          qa.set(q[k], q[k + 1], q[k + 2], q[k + 3])
          qb.copy(this.idle[b]).slerp(qa, clip.weights[f * 2 + s])
          q[k] = qb.x
          q[k + 1] = qb.y
          q[k + 2] = qb.z
          q[k + 3] = qb.w
        }
      }
    }
    // where the arms cross or touch, part them so they don't go through each other (contact.ts)
    keepArmsApart(q, clip.frames, this.body, clip)
    let c0 = -1
    let c1 = -1
    for (let f = 0; f < clip.frames; f++) {
      if (Math.max(clip.weights[f * 2], clip.weights[f * 2 + 1]) >= 0.99) {
        if (c0 < 0) c0 = f
        c1 = f
      }
    }
    const core: [number, number] = c0 < 0 ? [0, clip.frames - 1] : [c0, c1]
    this.twistPlan = [null, null]
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
        const ax = R.dir[a.lower]
        const read = 2 * Math.atan2(qc.x * ax.x + qc.y * ax.y + qc.z * ax.z, qc.w)
        // a hand bent back further than a wrist goes is a misreading (solveClip bridges it), and its turn about the
        // forearm can't be read
        this.bentBack[s] = ve.copy(ax).applyQuaternion(qc).dot(ax) < Math.cos(TWIST_READ_BEND)
        this.twistRead[s] = this.bentBack[s] ? NaN : read - TURN * Math.round(read / TURN)
        const turn = this.twistPlan[s]?.[this.frame] ?? (Number.isFinite(this.twistRead[s]) ? this.twistRead[s] : 0)
        W[a.lower].multiply(qd.setFromAxisAngle(ax, turn / 2))
        // the wrist: the hand seen from the forearm, split into where it points (its bend, kept to what a wrist can
        // do) and its own turn about itself (the other half of the planned turn), so neither can flip round
        qc.copy(W[a.lower]).invert().multiply(qb)
        const h = R.dir[a.hand]
        ve.copy(h).applyQuaternion(qc)
        qa.setFromUnitVectors(h, ve)
        qd.copy(qa).invert().multiply(qc)
        qa.setFromUnitVectors(h, limitCone(ve, h, WRIST_BEND))
        W[a.hand].copy(W[a.lower]).multiply(qa).multiply(qd)
      } else {
        this.twistRead[s] = NaN
        this.bentBack[s] = false
        W[a.hand].copy(W[a.lower])
      }

      // fingers: swing each bone from its rest direction onto the measured one, seen from its parent bone and kept
      // within what the joint can do
      this.thumbBend[s][0] = this.thumbBend[s][1] = 0
      a.fingers.forEach((chain, j) => {
        const lm = FINGER_LANDMARKS[j]
        let parentW = W[a.hand]
        for (let k = 0; k < chain.length; k++) {
          const b = chain[k]
          ve.subVectors(p[h0 + lm[k + 1]], p[h0 + lm[k]])
          if (ve.lengthSq() < 1e-10) {
            W[b].copy(parentW)
          } else {
            ve.normalize().applyQuaternion(qa.copy(parentW).invert())
            const joint = this.joints[b]
            if (joint) limitJoint(ve, joint)
            if (j === 0 && k === 0) {
              limitCone(ve, R.dir[b], THUMB_CONE)
              qb.setFromUnitVectors(R.dir[b], ve)
              this.turnThumb(p, h0, s, qa, ve, qb)
            } else {
              qb.setFromUnitVectors(R.dir[b], ve)
            }
            W[b].copy(parentW).multiply(qb)
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
    // (fingers are eased to rest in solveClip, once their glitches are filtered out)
    for (const s of [0, 1] as const) {
      const w = s === 0 ? wLeft : wRight
      const a = ARM[s]
      for (const b of [a.upper, a.lower, a.hand]) {
        qa.copy(this.local[b])
        this.local[b].copy(this.idle[b]).slerp(qa, w)
      }
    }
  }

  /**
   * The thumb's first bone, already aimed (local rotation q, direction d in the hand's frame): read how the tracked
   * thumb bends (for solveClip to smooth), then turn the bone about itself by this frame's twist. handInv is the
   * hand's world rotation, inverted.
   */
  private turnThumb(p: Vector3[], h0: number, s: 0 | 1, handInv: Quaternion, d: Vector3, q: Quaternion) {
    const lm = FINGER_LANDMARKS[0]
    va.subVectors(p[h0 + lm[2]], p[h0 + lm[1]]).normalize().applyQuaternion(handInv)
    vb.subVectors(p[h0 + lm[3]], p[h0 + lm[2]]).normalize().applyQuaternion(handInv)
    vc.copy(this.thumbHinge[s]).applyQuaternion(q)
    bendTwist(d, va, vb, vc, this.thumbBend[s])
    q.premultiply(qc.setFromAxisAngle(d, this.thumbTwist[s]))
  }

  /** Each finger and thumb joint's range, in its parent's frame, from the signer's rest pose. */
  private computeJoints(): (Joint | null)[] {
    const R = this.rest
    const joints: (Joint | null)[] = Array.from({ length: BONE_COUNT }, () => null)
    for (const s of [0, 1] as const) {
      const A = ARM[s]
      // the palm side: a left hand's palm lies along (fingers x knuckle line), a mirrored right hand's opposite
      const palm = new Vector3().crossVectors(R.dir[A.hand], R.handSide[s]).multiplyScalar(s === 0 ? 1 : -1)
      A.fingers.forEach((chain, j) => {
        if (j === 0) {
          this.thumbJoints(s, chain, palm, joints)
          return
        }
        chain.forEach((b, k) => {
          const u = R.dir[k === 0 ? A.hand : chain[k - 1]].clone()
          const a = R.handSide[s].clone().addScaledVector(u, -u.dot(R.handSide[s]))
          if (a.lengthSq() < 1e-6) return
          a.normalize()
          const w = new Vector3().crossVectors(a, u)
          if (w.dot(palm) < 0) w.negate()
          const d = R.dir[b]
          const restFlex = Math.atan2(d.dot(w), d.dot(u))
          const restSpread = Math.asin(Math.min(1, Math.max(-1, d.dot(a))))
          const r = FINGER_RANGE[k]
          joints[b] = {
            u,
            a,
            w,
            flex: [Math.min(r.flex[0] * RAD, restFlex), Math.max(r.flex[1] * RAD, restFlex)],
            spread: [restSpread - r.spread * RAD, restSpread + r.spread * RAD],
          }
        })
      })
    }
    return joints
  }

  /**
   * The thumb at rest: its hinge axis (from which way its nail faces, see THUMB_NAIL_TURN), and its knuckle and end
   * joints as hinges about it. palm: the way the palm faces at rest.
   */
  private thumbJoints(s: 0 | 1, chain: number[], palm: Vector3, joints: (Joint | null)[]) {
    const R = this.rest
    const d0 = R.dir[chain[0]]
    // round the thumb from the back of the hand towards the wrist: across the palm's plane, at right angles to the thumb
    const towardsWrist = new Vector3().crossVectors(palm, d0).normalize()
    if (towardsWrist.dot(R.dir[ARM[s].hand]) > 0) towardsWrist.negate()
    const nail = palm.clone().negate().normalize().multiplyScalar(Math.cos(THUMB_NAIL_TURN))
      .addScaledVector(towardsWrist, Math.sin(THUMB_NAIL_TURN))
    nail.addScaledVector(d0, -d0.dot(nail)).normalize()
    // the pad side is opposite the nail; the hinge is at right angles to both the thumb and its pad (w = a x u)
    const hinge = new Vector3().crossVectors(d0, nail.negate())
    this.thumbHinge[s].copy(hinge).normalize()
    for (let k = 1; k < chain.length; k++) {
      const u = R.dir[chain[k - 1]].clone()
      const a = this.thumbHinge[s].clone().addScaledVector(u, -u.dot(this.thumbHinge[s]))
      if (a.lengthSq() < 1e-6) continue
      a.normalize()
      const w = new Vector3().crossVectors(a, u)
      const d = R.dir[chain[k]]
      const restFlex = Math.atan2(d.dot(w), d.dot(u))
      const restSpread = Math.asin(Math.min(1, Math.max(-1, d.dot(a))))
      const r = THUMB_RANGE[k - 1]
      joints[chain[k]] = {
        u,
        a,
        w,
        flex: [Math.min(r.flex[0] * RAD, restFlex), Math.max(r.flex[1] * RAD, restFlex)],
        spread: [restSpread - r.spread * RAD, restSpread + r.spread * RAD],
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
