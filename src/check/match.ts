// Compares someone's signing with a recorded sign: the shape of each hand, which way it faces, where it is against the
// body, and how it moves. The pace may differ (learners sign slower than the dictionary's signers), and so may the
// hand: a left-handed signer, or someone copying the signer like a mirror, signs the mirror image, and that counts too.

import type { Clip } from '../signs/data'

/** frames per second the comparison works at */
export const RATE = 12.5

// the 13 body points the signs were recorded with (pipeline/bake.py): nose, eyes, ears, shoulders, elbows, wrists, hips
const BODY_N = 13
const L_SH = 5
const R_SH = 6
const L_WR = 9
const R_WR = 10
const L_HIP = 11
const R_HIP = 12
/** left/right pairs among the body points, swapped in the mirror image */
const PAIRS = [
  [1, 2],
  [3, 4],
  [5, 6],
  [7, 8],
  [9, 10],
  [11, 12],
]
const HAND_N = 21
/** the finger joints that make a handshape (the knuckles at the palm hardly move against it) */
const FINGERS = [2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20]
/** per hand: where it is (3), which way the fingers point (3), which way the palm faces (3), the fingers (15 × 3) */
const SIDE = 9 + FINGERS.length * 3
/** a hand counts as signing once its wrist is this far up from the hips towards the shoulders */
const RAISED = 0.2

// how much each part of a hand counts, in shoulder widths (where) and palm sizes (shape)
const W_WHERE = 1
const W_FACING = 0.5
const W_SHAPE = 1
/** a hand the sign uses but the attempt doesn't show */
const MISSING = 1.5
/** a hand the sign uses that's up in the attempt, but too blurred or turned for its shape to be seen */
const UNSEEN = 0.6
/** a hand raised that the sign doesn't use */
const EXTRA = 0.4

/** One moment of signing, described for comparing. */
export interface Feat {
  /** whether each hand [signer's left, right] is up and signing, its shape seen */
  on: [boolean, boolean]
  /** whether each hand is up, seen or not (only where it is is known then) */
  up: [boolean, boolean]
  v: Float32Array
}

type Hands = [ArrayLike<number> | null, ArrayLike<number> | null]

function unit(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1
  return [x / l, y / l, z / l]
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/**
 * Describe one moment. `body` is the 13 body points and `hands` 21 points per hand (null where the hand isn't seen),
 * all in metres in the app's axes (x to the signer's left, y up, z towards the viewer), shoulders facing the viewer.
 */
export function describe(body: ArrayLike<number>, hands: Hands): Feat {
  const v = new Float32Array(SIDE * 2)
  const p = (i: number, c: number) => body[i * 3 + c]
  const width = Math.hypot(p(L_SH, 0) - p(R_SH, 0), p(L_SH, 1) - p(R_SH, 1), p(L_SH, 2) - p(R_SH, 2)) || 0.35
  const cx = (p(L_SH, 0) + p(R_SH, 0)) / 2
  const cy = (p(L_SH, 1) + p(R_SH, 1)) / 2
  const cz = (p(L_SH, 2) + p(R_SH, 2)) / 2
  const hipY = (p(L_HIP, 1) + p(R_HIP, 1)) / 2
  const reach = Math.max(0.1, cy - hipY)
  const on: [boolean, boolean] = [false, false]
  const up: [boolean, boolean] = [false, false]

  for (let s = 0; s < 2; s++) {
    const h = hands[s]
    const wr = s === 0 ? L_WR : R_WR
    if ((p(wr, 1) - hipY) / reach < RAISED) continue
    up[s] = true
    const o = s * SIDE
    // where: the wrist against the middle of the shoulders, in shoulder widths (depth is the least reliable)
    v[o] = (p(wr, 0) - cx) / width
    v[o + 1] = (p(wr, 1) - cy) / width
    v[o + 2] = (0.5 * (p(wr, 2) - cz)) / width
    if (!h) continue
    on[s] = true
    // the palm: from the wrist (0) the middle finger's knuckle (9) runs along it, the index (5) and little finger's
    // (17) knuckles span it
    const at = (k: number): [number, number, number] => [h[k * 3] - h[0], h[k * 3 + 1] - h[1], h[k * 3 + 2] - h[2]]
    const a = at(5)
    const m = at(9)
    const b = at(17)
    const size = (Math.hypot(...a) + Math.hypot(...m) + Math.hypot(...b)) / 3 || 0.08
    const y = unit(...m)
    const x = unit(...cross(y, unit(...cross(a, b))))
    const n = cross(x, y)
    v.set(y, o + 3)
    v.set(n, o + 6)
    // the fingers in the palm's own frame, in palm sizes: the handshape, whichever way the hand is turned
    FINGERS.forEach((k, j) => {
      const d = at(k)
      const q = o + 9 + j * 3
      v[q] = (d[0] * x[0] + d[1] * x[1] + d[2] * x[2]) / size
      v[q + 1] = (d[0] * y[0] + d[1] * y[1] + d[2] * y[2]) / size
      v[q + 2] = (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / size
    })
  }
  return { on, up, v }
}

const NOTHING: Feat = { on: [false, false], up: [false, false], v: new Float32Array(SIDE * 2) }

const whereCost = (a: Float32Array, b: Float32Array, o: number) =>
  W_WHERE * Math.hypot(a[o] - b[o], a[o + 1] - b[o + 1], a[o + 2] - b[o + 2])

function sideCost(a: Float32Array, b: Float32Array, o: number): number {
  const facing =
    (Math.hypot(a[o + 3] - b[o + 3], a[o + 4] - b[o + 4], a[o + 5] - b[o + 5]) +
      Math.hypot(a[o + 6] - b[o + 6], a[o + 7] - b[o + 7], a[o + 8] - b[o + 8])) /
    2
  let shape = 0
  for (let q = o + 9; q < o + SIDE; q += 3) shape += Math.hypot(a[q] - b[q], a[q + 1] - b[q + 1], a[q + 2] - b[q + 2])
  return whereCost(a, b, o) + W_FACING * facing + (W_SHAPE * shape) / FINGERS.length
}

/** How far one moment of an attempt is from one moment of the sign; 0 is identical. */
export function frameCost(sign: Feat, attempt: Feat): number {
  let sum = 0
  let hands = 0
  for (let s = 0; s < 2; s++) {
    if (sign.on[s]) {
      hands++
      sum += attempt.on[s]
        ? sideCost(sign.v, attempt.v, s * SIDE)
        : attempt.up[s]
          ? whereCost(sign.v, attempt.v, s * SIDE) + UNSEEN
          : MISSING
    } else if (attempt.on[s]) sum += EXTRA
  }
  return sum / Math.max(1, hands)
}

/** A recorded sign at RATE, from the first moment a hand signs to the last. */
export function signFeats(clip: Clip, fps: number): Feat[] {
  const P = clip.points * 3
  const out: Feat[] = []
  for (let t = 0; t <= (clip.frames - 1) / fps; t += 1 / RATE) {
    const f = Math.min(clip.frames - 1, Math.round(t * fps))
    const at = f * P
    const hand = (s: number) =>
      clip.weights[f * 2 + s] >= 0.5
        ? clip.pts.subarray(at + (BODY_N + s * HAND_N) * 3, at + (BODY_N + (s + 1) * HAND_N) * 3)
        : null
    out.push(describe(clip.pts.subarray(at, at + BODY_N * 3), [hand(0), hand(1)]))
  }
  const signing = (f: Feat) => f.on[0] || f.on[1]
  const first = out.findIndex(signing)
  if (first < 0) return []
  let last = out.length - 1
  while (!signing(out[last])) last--
  return out.slice(first, last + 1)
}

/** Which way the shoulders are turned about the vertical, from points in MediaPipe's axes (as pipeline/bake.py). */
export function shoulderYaw(body: ArrayLike<number>): number {
  return Math.atan2(body[L_SH * 3 + 2] - body[R_SH * 3 + 2], body[L_SH * 3] - body[R_SH * 3])
}

/** MediaPipe's axes (y down, z away from the camera) to the app's, turned by `yaw` so the shoulders face the camera,
 *  and optionally reflected left to right. */
function toApp(src: ArrayLike<number>, yaw: number, mirror: boolean): Float32Array {
  const out = new Float32Array(src.length)
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i] * c + src[i + 2] * s
    const z = -src[i] * s + src[i + 2] * c
    out[i] = mirror ? -x : x
    out[i + 1] = -src[i + 1]
    out[i + 2] = -z
  }
  return out
}

function swapPairs(body: Float32Array): Float32Array {
  for (const [a, b] of PAIRS) {
    for (let c = 0; c < 3; c++) {
      const t = body[a * 3 + c]
      body[a * 3 + c] = body[b * 3 + c]
      body[b * 3 + c] = t
    }
  }
  return body
}

/** a hand that drops out of the tracking (blurred by a quick move, or turned edge-on) is held this long, ms */
const HOLD_MS = 300

/** Take the jitter out of the tracking without delaying it: each moment is averaged with the ones either side
 *  (1-2-1), where a hand is seen in all three. The recorded signs were smoothed the same way round. */
function steadied(fs: Feat[]): Feat[] {
  return fs.map((f, k) => {
    const a = fs[k - 1]
    const b = fs[k + 1]
    if (!a || !b) return f
    let v: Float32Array | null = null
    for (let s = 0; s < 2; s++) {
      if (!(f.on[s] && a.on[s] && b.on[s])) continue
      v ??= f.v.slice()
      for (let q = s * SIDE; q < (s + 1) * SIDE; q++) v[q] = (a.v[q] + 2 * f.v[q] + b.v[q]) / 4
    }
    return v ? { ...f, v } : f
  })
}

/**
 * Someone's signing as the camera follows it: the last few seconds, kept as they are and as their mirror image,
 * ready to compare. Points come in MediaPipe's world axes, as the tracker gives them.
 */
export class Attempt {
  private frames: { t: number; f: Feat; m: Feat }[] = []
  private yaw: number | null = null
  /** each hand as last seen (MediaPipe's axes), and when, ms */
  private hands: [ArrayLike<number> | null, ArrayLike<number> | null] = [null, null]
  private seenAt = [-Infinity, -Infinity]

  constructor(
    /** how much to keep, ms */
    private keep = 10_000,
  ) {}

  add(t: number, body: ArrayLike<number> | null, hands: Hands) {
    let f = NOTHING
    let m = NOTHING
    for (let s = 0; s < 2; s++) {
      const h = hands[s]
      if (h) {
        this.hands[s] = h
        this.seenAt[s] = t
      } else if (t - this.seenAt[s] > HOLD_MS) this.hands[s] = null
    }
    if (body) {
      // the shoulders' turn, steadied: one frame's depth guess is noisy
      const y = shoulderYaw(body)
      this.yaw = this.yaw === null ? y : this.yaw + 0.15 * (y - this.yaw)
      const yaw = this.yaw
      const hand = (h: ArrayLike<number> | null, mirror: boolean) => (h ? toApp(h, yaw, mirror) : null)
      const [l, r] = this.hands
      f = describe(toApp(body, yaw, false), [hand(l, false), hand(r, false)])
      // the mirror image: reflected, so the left hand becomes a right hand and the other way round
      m = describe(swapPairs(toApp(body, yaw, true)), [hand(r, true), hand(l, true)])
    }
    this.frames.push({ t, f, m })
    while (this.frames.length && this.frames[0].t < t - this.keep) this.frames.shift()
  }

  clear() {
    this.frames = []
    this.hands = [null, null]
    this.seenAt = [-Infinity, -Infinity]
  }

  get length() {
    return this.frames.length
  }

  /** the attempt at RATE, oldest first, and its mirror image; a moment with no frame near it shows nothing */
  series(): Series {
    const plain: Feat[] = []
    const mirrored: Feat[] = []
    const fr = this.frames
    if (!fr.length) return { plain, mirrored }
    const step = 1000 / RATE
    const t0 = fr[0].t
    const t1 = fr[fr.length - 1].t
    let k = 0
    for (let t = t0; t <= t1 + 1e-6; t += step) {
      while (k + 1 < fr.length && Math.abs(fr[k + 1].t - t) <= Math.abs(fr[k].t - t)) k++
      const near = Math.abs(fr[k].t - t) <= 1.6 * step
      plain.push(near ? fr[k].f : NOTHING)
      mirrored.push(near ? fr[k].m : NOTHING)
    }
    return { plain: steadied(plain), mirrored: steadied(mirrored) }
  }
}

/** An attempt at RATE, oldest first, as it is and as its mirror image. */
export interface Series {
  plain: Feat[]
  mirrored: Feat[]
}

/** how many times longer (or shorter) than the recording an attempt may take, before the stretch each step allows */
const PACES = [0.7, 1, 1.4, 2, 2.8]

interface Stretch {
  /** how far the stretch is from the sign, per frame: 0 is identical */
  cost: number
  /** the attempt's frames it spans */
  from: number
  to: number
}

/**
 * The cheapest way to line the sign (stretched to `pace`) up with some stretch of the attempt, averaged per frame.
 * Each step moves one frame on in both, or skips one frame of either, so the pace can drift between half and double.
 */
function stretchCost(C: Float32Array, n: number, m: number, pace: number): Stretch {
  const none = { cost: Infinity, from: 0, to: 0 }
  const rows = Math.max(2, Math.round(n * pace))
  if (rows > 2 * m) return none
  const base = new Int32Array(rows)
  for (let i = 0; i < rows; i++) base[i] = Math.min(n - 1, Math.round((i * (n - 1)) / (rows - 1)))
  const c = (i: number, j: number) => C[base[i] * m + j]
  const D = new Float32Array(rows * m).fill(Infinity)
  const S = new Int32Array(rows * m)
  for (let j = 0; j < m; j++) {
    D[j] = 2 * c(0, j)
    S[j] = j
  }
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < m; j++) {
      let best = D[(i - 1) * m + j - 1] + 2 * c(i, j)
      let from = (i - 1) * m + j - 1
      if (j >= 2) {
        const v = D[(i - 1) * m + j - 2] + 2 * c(i, j - 1) + c(i, j)
        if (v < best) {
          best = v
          from = (i - 1) * m + j - 2
        }
      }
      if (i >= 2) {
        const v = D[(i - 2) * m + j - 1] + 2 * c(i - 1, j) + c(i, j)
        if (v < best) {
          best = v
          from = (i - 2) * m + j - 1
        }
      }
      D[i * m + j] = best
      S[i * m + j] = S[from]
    }
  }
  // each path's steps weigh (sign frames + attempt frames) in all: divide by that for a per-frame figure
  const out = none
  for (let j = 0; j < m; j++) {
    const d = D[(rows - 1) * m + j]
    if (d === Infinity) continue
    const from = S[(rows - 1) * m + j]
    const cost = d / (rows + 1 + j - from)
    if (cost < out.cost) Object.assign(out, { cost, from, to: j })
  }
  return out
}

export interface Verdict extends Stretch {
  /** the closest was the mirror image (the other hand, or copied like a mirror) */
  mirrored: boolean
}

/**
 * Find the stretch of an attempt closest to the sign, at any pace, either way round. With `only`, look just at those
 * frames that way round: does another sign explain the same stretch of signing better?
 */
export function compare(sign: Feat[], attempt: Series, only?: { mirrored: boolean; from: number; to: number }): Verdict {
  let best: Verdict = { cost: Infinity, from: 0, to: 0, mirrored: false }
  const n = sign.length
  if (!n) return best
  for (const mirrored of only ? [only.mirrored] : [false, true]) {
    const all = mirrored ? attempt.mirrored : attempt.plain
    const off = only ? Math.max(0, only.from) : 0
    const live = only ? all.slice(off, Math.min(all.length, only.to + 1)) : all
    const m = live.length
    if (m < 2) continue
    const C = new Float32Array(n * m)
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) C[i * m + j] = frameCost(sign[i], live[j])
    for (const pace of PACES) {
      const s = stretchCost(C, n, m, pace)
      if (s.cost < best.cost) best = { cost: s.cost, from: s.from + off, to: s.to + off, mirrored }
    }
  }
  return best
}

/** How close another sign comes to the stretch of the attempt that `v` matched (and a little either side), the same
 *  way round. A sign counts only if no other sign explains the signing clearly better (MARGIN). */
export function rivalCost(rival: Feat[], attempt: Series, v: Verdict): number {
  const pad = Math.round(RATE * 0.6)
  return compare(rival, attempt, { mirrored: v.mirrored, from: v.from - pad, to: v.to + pad }).cost
}

/** At or under this, an attempt counts as the sign, unless another sign comes closer (MARGIN). */
export const PASS = 0.8
/** an attempt counts only if no other sign is closer than this much less */
export const MARGIN = 0.1
/** Over this, an attempt is nowhere near. */
const FAR = 1.4

/** How close an attempt came, from 0 (nowhere near) to 1 (it counts). */
export function closeness(cost: number): number {
  return Math.max(0, Math.min(1, (FAR - cost) / (FAR - PASS)))
}
