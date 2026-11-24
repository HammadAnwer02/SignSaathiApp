// Keeps the signer's two arms from going through each other.
//
// The solver aims each bone the way the video's bone points, so where the hands end up depends on the signer's own
// build. Where the person in the video crosses their forearms or rests one hand on the other, the signer's arms can
// sink into each other, and as the tracking wobbles they swap which one is on top from one frame to the next. Once a
// clip is solved, this pass finds where the arms (upper arm, forearm and palm, and the fingers, as capsules sized from
// the signer's bones) overlap, and moves them apart along one line for each stretch of contact until they just touch,
// so the same arm stays on top all through it. Which arm that is: the one the video has on top, unless the arms can
// only be kept apart the other way, or the video's way needs them moved much further. Fingers can curl round the other
// hand, so they are only kept out where a little more of a move does it. An arm is moved by turning it at the shoulder
// and bending the elbow, the least that moves its wrist far enough, and its hand keeps the angle and shape the video
// shows; an arm going forwards moves more than one going back into the body. How far the arms are moved apart, frame by
// frame, is planned over the whole stretch and a few frames either side, trying every distance in every frame: they
// part and meet smoothly, and are never pushed into each other on the way, even where they come together from the
// other side.

import { Quaternion, Vector3 } from 'three'
import type { Clip } from '../signs/data'
import { ARM, BONE_COUNT, CHEST, CLIP_POINT, FINGER_LANDMARKS, SPINE, type Rest } from './rig'

// capsule radii as fractions of the signer's bones (measured on both signers' meshes, sleeves included)
const UPPER_R = [0.3, 0.23] as const // shoulder end, elbow end; x the upper arm
const FORE_R = [0.235, 0.15] as const // elbow end, wrist end; x the forearm
const PALM_R = 0.16 // half the palm's thickness; x wrist to middle knuckle
const FINGER_R = 0.5 // x the index finger's first bone
const TIP = 0.85 // a finger's end bone; x the bone before it

const NEAR = 0.015 // m between the arms' surfaces: touching
const JOIN = 3 // frames: touches no further apart than this are one stretch of contact
const RAMP = 5 // frames either side of a stretch of contact the arms can be eased apart and back together over
const MAX_PUSH = 0.2 // m: the furthest the arms are moved apart
const LEVEL = 0.005 // m: every push up to MAX_PUSH in steps of this is tried
const MAX_TURN = 0.6 // radians: the furthest an arm is turned at the shoulder
const STRAIGHT = 0.15 // radians: an elbow isn't straightened further than this short of straight...
const FOLDED = 2.5 // ...nor bent further than this
const SLACK = 0.002 // m of overlap allowed (skin and cloth give a little)
const LEFT_COST = 100 // the arms' overlap left over costs this many times as much as moving them that far: they are
// parted wherever they can be, and the arm the video has on top only stays on top where that leaves them clear
const FINGER_COST = 3 // fingers left in the other arm count this many times as much as moving the arms that far...
const FINGER_CAP = 0.02 // ...but no deeper than this (m), so only a little more of a move is spent on them: they can lace
// and hook round the other hand, where no push clears them
const SMOOTH = 50 // per m: changing the push by d m from one frame to the next costs as much as SMOOTH d² m of push
const VIDEO = 3 // which arm the video has on top: each m it is clear by counts as much as moving the arms this many m
const SRC_DEPTH = 0.5 // how much the video's depth counts, against its height and side to side (it is a guess)
const BACK = 0.25 // an arm pushed straight back towards the body moves this much, against 1 for one pushed forwards
const CROSS = 0.3 // nearer than this (of their radii added), crossing capsules part along the normal to both

// an arm's points: shoulder, elbow, wrist, then each finger's three joints and its tip
const SH = 0
const EL = 1
const WR = 2
const POINTS = 23
const fingerPoint = (j: number, k: number) => 3 + 4 * j + k
// an arm's capsules: the upper arm, forearm and three across the palm (the arm itself), then three per finger
const ARM_CAPS = 5
const CAPS = ARM_CAPS + 15
/** pairs of capsules (left, right) that are checked: the arms themselves against each other, and each arm's fingers
 *  against the other arm. Fingers against fingers aren't: they can lace and hook round each other. */
const checked = (i: number, j: number, fingers: boolean) =>
  i < ARM_CAPS && j < ARM_CAPS ? i + j > 0 : fingers && (i < ARM_CAPS || j < ARM_CAPS)

interface Capsule {
  /** its two ends (arm points) and its radius at each */
  a: number
  b: number
  ra: number
  rb: number
}

/** The signer's arms as capsules, measured from its rest pose. */
export interface ArmBody {
  rest: Rest
  /** per side, per finger: the tip's offset from the finger's end bone, at rest */
  tip: Vector3[][]
  /** per side: the arm's capsules (see ARM_CAPS) */
  caps: Capsule[][]
}

export function armBody(rest: Rest): ArmBody {
  const P = rest.pos
  const len = (a: number, b: number) => P[a].distanceTo(P[b])
  const tip: Vector3[][] = []
  const caps: Capsule[][] = []
  for (const s of [0, 1] as const) {
    const A = ARM[s]
    const upper = len(A.upper, A.lower)
    const fore = len(A.lower, A.hand)
    const palm = PALM_R * len(A.hand, A.fingers[2][0])
    const finger = FINGER_R * len(A.fingers[1][0], A.fingers[1][1])
    const index = fingerPoint(1, 0)
    const little = fingerPoint(4, 0)
    const c: Capsule[] = [
      { a: SH, b: EL, ra: UPPER_R[0] * upper, rb: UPPER_R[1] * upper },
      { a: EL, b: WR, ra: FORE_R[0] * fore, rb: FORE_R[1] * fore },
      { a: WR, b: index, ra: palm, rb: palm },
      { a: WR, b: little, ra: palm, rb: palm },
      { a: index, b: little, ra: palm, rb: palm },
    ]
    for (let j = 0; j < 5; j++) {
      for (let k = 0; k < 3; k++) c.push({ a: fingerPoint(j, k), b: fingerPoint(j, k + 1), ra: finger, rb: finger })
    }
    caps.push(c)
    tip.push(A.fingers.map((chain) => rest.dir[chain[2]].clone().multiplyScalar(TIP * len(chain[1], chain[2]))))
  }
  return { rest, tip, caps }
}

/** One frame of a solved clip: every arm point (model space), and the world rotations parting the arms changes. */
export interface PosedArms {
  /** per side: shoulder, elbow, wrist, then each finger's three joints and its tip */
  pts: [Vector3[], Vector3[]]
  chest: Quaternion
  upper: [Quaternion, Quaternion]
  lower: [Quaternion, Quaternion]
  hand: [Quaternion, Quaternion]
}

// scratch (all of this runs synchronously)
const qa = new Quaternion(), qb = new Quaternion(), qc = new Quaternion()
const va = new Vector3(), vb = new Vector3(), vc = new Vector3(), vd = new Vector3()
const c1 = new Vector3(), c2 = new Vector3()
const st = [0, 0]

/** Frame f of the local rotations q, posed. */
export function poseArms(q: Float32Array, f: number, body: ArmBody): PosedArms {
  const R = body.rest.pos
  const local = (b: number) => {
    const k = (f * BONE_COUNT + b) * 4
    return qa.set(q[k], q[k + 1], q[k + 2], q[k + 3])
  }
  // where a bone is: its parent's place, plus its offset from the parent at rest turned the way the parent is turned
  const child = (b: number, parent: number, at: Vector3, turn: Quaternion) =>
    R[b].clone().sub(R[parent]).applyQuaternion(turn).add(at)
  const spine = local(SPINE).clone()
  const chest = spine.clone().multiply(local(CHEST))
  const chestAt = child(CHEST, SPINE, R[SPINE], spine)
  const out: PosedArms = {
    pts: [[], []],
    chest,
    upper: [new Quaternion(), new Quaternion()],
    lower: [new Quaternion(), new Quaternion()],
    hand: [new Quaternion(), new Quaternion()],
  }
  for (const s of [0, 1] as const) {
    const A = ARM[s]
    const pts = out.pts[s]
    const up = out.upper[s].copy(chest).multiply(local(A.upper))
    pts[SH] = child(A.upper, CHEST, chestAt, chest)
    const lo = out.lower[s].copy(up).multiply(local(A.lower))
    pts[EL] = child(A.lower, A.upper, pts[SH], up)
    pts[WR] = child(A.hand, A.lower, pts[EL], lo)
    const hand = out.hand[s].copy(lo).multiply(local(A.hand))
    A.fingers.forEach((chain, j) => {
      const turn = qb.copy(hand)
      let parent = A.hand
      let at = pts[WR]
      chain.forEach((b, k) => {
        at = pts[fingerPoint(j, k)] = child(b, parent, at, turn)
        turn.multiply(local(b))
        parent = b
      })
      pts[fingerPoint(j, 3)] = body.tip[s][j].clone().applyQuaternion(turn).add(at)
    })
  }
  return out
}

const EPS = 1e-12
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** The nearest points of segments p1-q1 and p2-q2, into o1 and o2; how far along each they are goes into st. */
function closest(p1: Vector3, q1: Vector3, p2: Vector3, q2: Vector3, o1: Vector3, o2: Vector3) {
  // Ericson, Real-Time Collision Detection, 5.1.9
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z
  const a = d1x * d1x + d1y * d1y + d1z * d1z
  const e = d2x * d2x + d2y * d2y + d2z * d2z
  const f = d2x * rx + d2y * ry + d2z * rz
  let s = 0
  let t = 0
  if (a <= EPS) {
    if (e > EPS) t = clamp01(f / e)
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz
    if (e <= EPS) s = clamp01(-c / a)
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z
      const den = a * e - b * b
      if (den > EPS) s = clamp01((b * f - c * e) / den)
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = clamp01(-c / a)
      } else if (t > 1) {
        t = 1
        s = clamp01((b - c) / a)
      }
    }
  }
  o1.set(p1.x + d1x * s, p1.y + d1y * s, p1.z + d1z * s)
  o2.set(p2.x + d2x * t, p2.y + d2y * t, p2.z + d2z * t)
  st[0] = s
  st[1] = t
}

const radius = (c: Capsule, s: number) => c.ra + (c.rb - c.ra) * s

/** Where the two arms come nearest in one frame. */
export interface Contact {
  /** the nearest pair of capsules: surface to surface (m; below 0 they overlap), the left arm's and the right's */
  gap: number
  i: number
  j: number
  /** from the right capsule's nearest point to the left's */
  d: Vector3
  /** the two capsules' directions, and whether they cross (their nearest points inside both) */
  ui: Vector3
  uj: Vector3
  crossing: boolean
  /** their radii there, added */
  reach: number
  /** the nearest pair of the arms themselves (no fingers) */
  ai: number
  aj: number
  /** each checked pair's gap, [i * CAPS + j] */
  gaps: Float32Array
}

/** Where the arms come nearest in a posed frame. */
export function armContact(P: PosedArms, body: ArmBody): Contact {
  const [L, R] = P.pts
  const [cl, cr] = body.caps
  const out: Contact = {
    gap: Infinity, i: 0, j: 0, d: new Vector3(), ui: new Vector3(), uj: new Vector3(), crossing: false, reach: 0,
    ai: 0, aj: 1, gaps: new Float32Array(CAPS * CAPS).fill(Infinity),
  }
  let armGap = Infinity
  for (let i = 0; i < CAPS; i++) {
    for (let j = 0; j < CAPS; j++) {
      if (!checked(i, j, true)) continue
      const a = cl[i]
      const b = cr[j]
      closest(L[a.a], L[a.b], R[b.a], R[b.b], c1, c2)
      const reach = radius(a, st[0]) + radius(b, st[1])
      const gap = c1.distanceTo(c2) - reach
      out.gaps[i * CAPS + j] = gap
      if (i < ARM_CAPS && j < ARM_CAPS && gap < armGap) {
        armGap = gap
        out.ai = i
        out.aj = j
      }
      if (gap < out.gap) {
        out.gap = gap
        out.i = i
        out.j = j
        out.d.subVectors(c1, c2)
        out.ui.subVectors(L[a.b], L[a.a]).normalize()
        out.uj.subVectors(R[b.b], R[b.a]).normalize()
        out.crossing = st[0] > 0.02 && st[0] < 0.98 && st[1] > 0.02 && st[1] < 0.98
        out.reach = reach
      }
    }
  }
  return out
}

/**
 * The line the arms part along through a stretch of contact (either way along it): the line their nearest points
 * meet along, frame by frame (for capsules crossing near their middles, the normal to both), averaged over the stretch
 * with the deeper overlaps counting more. One line for the whole stretch, so the arms can't swap over partway.
 */
function partLine(near: Contact[], a: number, b: number): Vector3 {
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  const v = new Vector3()
  for (let f = a; f <= b; f++) {
    const c = near[f]
    const len = c.d.length()
    if (len > CROSS * c.reach) v.copy(c.d).divideScalar(len)
    else if (c.crossing && v.crossVectors(c.ui, c.uj).lengthSq() > 0.04) v.normalize()
    else if (len > 1e-6) v.copy(c.d).divideScalar(len)
    else continue
    const w = Math.max(0, -c.gap) + 0.005
    const e = [v.x, v.y, v.z]
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) m[r * 3 + k] += w * e[r] * e[k]
  }
  // its main direction, by power iteration from the axis it leans along most
  const d = [m[0], m[4], m[8]]
  const out = new Vector3().setComponent(d.indexOf(Math.max(...d)), 1)
  for (let k = 0; k < 30; k++) {
    v.set(
      m[0] * out.x + m[1] * out.y + m[2] * out.z,
      m[3] * out.x + m[4] * out.y + m[5] * out.z,
      m[6] * out.x + m[7] * out.y + m[8] * out.z,
    )
    if (v.lengthSq() < 1e-20) return out.set(0, 0, 1)
    out.copy(v).normalize()
  }
  return out
}

type SourceClip = Pick<Clip, 'pts' | 'points' | 'weights'>

/** Where an arm point was in the video in frame f (a hand's points are placed from the video's wrist). */
function sourcePoint(clip: SourceClip, f: number, s: 0 | 1, k: number, out: Vector3): Vector3 {
  const at = (i: number, o: Vector3) => {
    const x = (f * clip.points + i) * 3
    return o.set(clip.pts[x], clip.pts[x + 1], clip.pts[x + 2])
  }
  if (k === SH) return at(CLIP_POINT.shoulder[s], out)
  if (k === EL) return at(CLIP_POINT.elbow[s], out)
  at(CLIP_POINT.wrist[s], out)
  if (k === WR) return out
  const h0 = CLIP_POINT.hand[s]
  return out.add(at(h0 + FINGER_LANDMARKS[(k - 3) >> 2][(k - 3) & 3], vc)).sub(at(h0, vd))
}

const s1 = new Vector3(), s2 = new Vector3(), s3 = new Vector3(), s4 = new Vector3()

/** How far the video's left arm was from its right along line, where this frame's nearest capsules are (its depth
 *  counting for less). */
function sourceSide(clip: SourceClip, f: number, body: ArmBody, c: Contact, line: Vector3): number {
  const a = body.caps[0][c.i]
  const b = body.caps[1][c.j]
  closest(sourcePoint(clip, f, 0, a.a, s1), sourcePoint(clip, f, 0, a.b, s2), sourcePoint(clip, f, 1, b.a, s3),
    sourcePoint(clip, f, 1, b.b, s4), c1, c2)
  va.subVectors(c1, c2)
  return va.x * line.x + va.y * line.y + SRC_DEPTH * va.z * line.z
}

// per side: the arm's turn at the shoulder, and its elbow's further bend (about its hinge), from turns()
const shoulderTurn: [Quaternion, Quaternion] = [new Quaternion(), new Quaternion()]
const elbowTurn: [Quaternion, Quaternion] = [new Quaternion(), new Quaternion()]
const lever: [Vector3, Vector3] = [new Vector3(), new Vector3()]
const hinge: [Vector3, Vector3] = [new Vector3(), new Vector3()]

/**
 * How each arm turns to part the arms by push along n (the left arm along +n): at the shoulder and by bending the
 * elbow, the least turning that moves its wrist its share of the way. The arm that can move its wrist that way more
 * freely takes more of the push, and an arm going forwards more than one going back towards the body.
 */
function turns(P: PosedArms, n: Vector3, push: number) {
  const gain = [0, 0]
  const bendLever = [0, 0]
  const w = [0, 0]
  for (const s of [0, 1] as const) {
    const [S, E, W] = P.pts[s]
    const way = vb.copy(n).multiplyScalar(s === 0 ? 1 : -1)
    // turning the arm at the shoulder about (wrist - shoulder) x way moves the wrist that way by its length per radian
    lever[s].subVectors(W, S).cross(way)
    // bending the elbow about its hinge moves the wrist that way by hinge . (forearm x way) per radian
    hinge[s].subVectors(E, S).cross(va.subVectors(W, E))
    if (hinge[s].lengthSq() > 1e-10) bendLever[s] = hinge[s].normalize().dot(vc.subVectors(W, E).cross(way))
    gain[s] = lever[s].lengthSq() + bendLever[s] * bendLever[s]
    w[s] = gain[s] * (BACK + ((1 - BACK) * (1 + way.z)) / 2)
  }
  const total = w[0] + w[1]
  for (const s of [0, 1] as const) {
    const [S, E, W] = P.pts[s]
    const per = gain[s] > 1e-12 ? ((total > 1e-12 ? w[s] / total : 0.5) * push) / gain[s] : 0
    const len = lever[s].length()
    shoulderTurn[s].setFromAxisAngle(len > 1e-9 ? va.copy(lever[s]).divideScalar(len) : va.set(1, 0, 0),
      Math.min(MAX_TURN, len * per))
    // the elbow kept between nearly straight and folded
    const bent = va.subVectors(E, S).angleTo(vc.subVectors(W, E))
    const bend = Math.min(Math.max(bendLever[s] * per, Math.min(0, STRAIGHT - bent)), Math.max(0, FOLDED - bent))
    elbowTurn[s].setFromAxisAngle(hinge[s], bendLever[s] === 0 ? 0 : bend)
  }
}

const moved: [Vector3[], Vector3[]] = [
  Array.from({ length: POINTS }, () => new Vector3()),
  Array.from({ length: POINTS }, () => new Vector3()),
]

/** The arms' points once parted by push along n, each hand carried along by its wrist without turning. Returns the
 *  furthest an elbow or wrist moved on each arm, added (no pair of points comes nearer by more than that). */
function moveArms(P: PosedArms, n: Vector3, push: number): number {
  turns(P, n, push)
  let reach = 0
  for (const s of [0, 1] as const) {
    const from = P.pts[s]
    const to = moved[s]
    to[SH].copy(from[SH])
    to[EL].subVectors(from[EL], from[SH]).applyQuaternion(shoulderTurn[s]).add(from[SH])
    to[WR].subVectors(from[WR], from[EL]).applyQuaternion(elbowTurn[s]).applyQuaternion(shoulderTurn[s]).add(to[EL])
    const shift = va.subVectors(to[WR], from[WR])
    for (let k = 3; k < POINTS; k++) to[k].copy(from[k]).add(shift)
    reach += Math.max(to[EL].distanceTo(from[EL]), shift.length())
  }
  return reach
}

// how deep the arms still overlap once parted (m; 0 once clear): the arms themselves, and fingers in the other arm
const over = [0, 0]

/**
 * How deep the arms still overlap once parted by push along n, into over. signed: the nearest pair of the arms
 * themselves must also end up with the left arm on the + side of n, so the same arm stays on top.
 */
function overlaps(P: PosedArms, body: ArmBody, c: Contact, n: Vector3, push: number, signed: boolean) {
  const shifted = moveArms(P, n, push)
  const [L, R] = moved
  const [cl, cr] = body.caps
  over[0] = 0
  over[1] = 0
  for (let i = 0; i < CAPS; i++) {
    for (let j = 0; j < CAPS; j++) {
      if (!checked(i, j, true)) continue
      const main = signed && i === c.ai && j === c.aj
      // a pair too far apart to meet however far the arms move is skipped
      if (!main && c.gaps[i * CAPS + j] - shifted > 0) continue
      const a = cl[i]
      const b = cr[j]
      closest(L[a.a], L[a.b], R[b.a], R[b.b], c1, c2)
      const reach = radius(a, st[0]) + radius(b, st[1])
      const d = vd.subVectors(c1, c2)
      let need: number
      if (main) {
        // far enough along n to clear each other, given how far apart they are across it
        const along = d.dot(n)
        const across2 = d.lengthSq() - along * along
        need = across2 < reach * reach ? Math.sqrt(reach * reach - across2) - along : reach - d.length()
      } else need = reach - d.length()
      const kind = i < ARM_CAPS && j < ARM_CAPS ? 0 : 1
      if (need > over[kind]) over[kind] = need
    }
  }
}

/**
 * How far to part the arms along n (the left arm along +n) in each frame from A to B: a stretch of contact, a to b,
 * and a few frames either side to ease in and out over. Every push up to MAX_PUSH is tried in every frame, and the run
 * of pushes that costs least is kept (dynamic programming): the pushes themselves, the overlap they leave, and how
 * sharply they change from frame to frame, from none before A to none after B (unless the clip starts or ends there).
 * Through the stretch the arms must also stay on their own sides of n; either side of it they need only not overlap.
 * Returns the pushes (from frame A), how much they move the arms and how sharply (the pushes added, and the changes'
 * cost), and the arms' overlap they leave (m, over the frames).
 */
function plan(posed: PosedArms[], near: Contact[], body: ArmBody, n: Vector3, A: number, B: number, a: number,
  b: number, frames: number) {
  const levels = Math.round(MAX_PUSH / LEVEL) + 1
  const len = B - A + 1
  const best = new Float64Array(len * levels) // the least cost of frames A to this one, ending at this push
  const from = new Uint8Array(len * levels) // the push the frame before had, on that way
  const leftAt = new Float64Array(len * levels) // the arms' overlap this push leaves in this frame
  const change = (k: number, j: number) => SMOOTH * ((k - j) * LEVEL) ** 2
  for (let t = 0; t < len; t++) {
    const f = A + t
    for (let k = 0; k < levels; k++) {
      overlaps(posed[f], body, near[f], n, k * LEVEL, f >= a && f <= b)
      leftAt[t * levels + k] = Math.max(0, over[0] - SLACK)
      let cost = k * LEVEL + LEFT_COST * leftAt[t * levels + k] +
        FINGER_COST * Math.min(FINGER_CAP, Math.max(0, over[1] - SLACK))
      if (t === 0) cost += A > 0 ? change(k, 0) : 0
      else {
        let least = Infinity
        for (let j = 0; j < levels; j++) {
          const v = best[(t - 1) * levels + j] + change(k, j)
          if (v < least) {
            least = v
            from[t * levels + k] = j
          }
        }
        cost += least
      }
      best[t * levels + k] = cost
    }
  }
  let k = 0
  let cost = Infinity
  for (let j = 0; j < levels; j++) {
    const v = best[(len - 1) * levels + j] + (B < frames - 1 ? change(j, 0) : 0)
    if (v < cost) {
      cost = v
      k = j
    }
  }
  const push = new Float64Array(len)
  let moves = B < frames - 1 ? change(k, 0) : 0
  let left = 0
  for (let t = len - 1; t >= 0; t--) {
    push[t] = k * LEVEL
    left += leftAt[t * levels + k]
    const j = t > 0 ? from[t * levels + k] : 0
    moves += push[t] + (t > 0 || A > 0 ? change(k, j) : 0)
    k = j
  }
  return { push, moves, left }
}

/** Stretches of frames where the arms touch, [first, last]; touches only a few frames apart join up. */
function stretches(near: Contact[]): [number, number][] {
  const out: [number, number][] = []
  near.forEach((c, f) => {
    if (c.gap >= NEAR) return
    const last = out[out.length - 1]
    if (last && f - last[1] <= JOIN + 1) last[1] = f
    else out.push([f, f])
  })
  return out
}

function write(q: Float32Array, f: number, b: number, r: Quaternion) {
  const k = (f * BONE_COUNT + b) * 4
  q[k] = r.x
  q[k + 1] = r.y
  q[k + 2] = r.z
  q[k + 3] = r.w
}

/** Part the arms by push along n in frame f: each arm turns at the shoulder and bends at the elbow as turns() says, and
 *  its hand keeps the way it was turned in the world. */
function part(q: Float32Array, f: number, P: PosedArms, n: Vector3, push: number) {
  turns(P, n, push)
  for (const s of [0, 1] as const) {
    const up = qb.copy(shoulderTurn[s]).multiply(P.upper[s])
    const lo = qc.copy(shoulderTurn[s]).multiply(elbowTurn[s]).multiply(P.lower[s])
    write(q, f, ARM[s].upper, qa.copy(P.chest).invert().multiply(up))
    write(q, f, ARM[s].lower, qa.copy(up).invert().multiply(lo))
    write(q, f, ARM[s].hand, qa.copy(lo).invert().multiply(P.hand[s]))
  }
}

/**
 * Part the arms wherever they go into each other in a solved clip (local rotations q, frames long), in place.
 * clip: the clip's video points, so the arm the video has on top can stay on top.
 */
export function keepArmsApart(q: Float32Array, frames: number, body: ArmBody, clip?: SourceClip) {
  const posed: PosedArms[] = []
  const near: Contact[] = []
  for (let f = 0; f < frames; f++) {
    posed.push(poseArms(q, f, body))
    near.push(armContact(posed[f], body))
  }
  // one stretch of contact at a time, each taking the arms as the one before left them
  for (const [a, b] of stretches(near)) {
    const line = partLine(near, a, b)
    // which way along the line the left arm goes: the way that costs least, counting what the video shows
    let video = 0
    if (clip) {
      for (let f = a; f <= b; f++) {
        video += VIDEO * sourceSide(clip, f, body, near[f], line) * Math.min(clip.weights[f * 2], clip.weights[f * 2 + 1])
      }
    }
    const A = Math.max(0, a - RAMP)
    const B = Math.min(frames - 1, b + RAMP)
    const back = line.clone().negate()
    const one = plan(posed, near, body, line, A, B, a, b, frames)
    const other = plan(posed, near, body, back, A, B, a, b, frames)
    const cost = (p: ReturnType<typeof plan>) => p.moves + LEFT_COST * p.left
    const [way, push] = cost(one) - video <= cost(other) + video ? [line, one.push] : [back, other.push]
    for (let f = A; f <= B; f++) {
      if (push[f - A] === 0) continue
      part(q, f, posed[f], way, push[f - A])
      posed[f] = poseArms(q, f, body)
      near[f] = armContact(posed[f], body)
    }
  }
}
