import { describe, expect, it } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import { ARM, BONES, BONE_COUNT, CHEST, CLIP_POINT, HEAD, NECK, SPINE, type Rest } from './rig'
import { armBody, armContact, keepArmsApart, poseArms } from './contact'

/** A T-posed signer about the size of the app's female one: arms out to the sides (+x is its left), palms down. */
function tPose(): Rest {
  const pos = BONES.map(() => new Vector3())
  pos[SPINE].set(0, 1.0, 0)
  pos[CHEST].set(0, 1.2, 0)
  pos[NECK].set(0, 1.42, 0)
  pos[HEAD].set(0, 1.5, 0)
  for (const s of [0, 1] as const) {
    const x = s === 0 ? 1 : -1
    const A = ARM[s]
    pos[A.upper].set(0.15 * x, 1.38, 0)
    pos[A.lower].set(0.38 * x, 1.38, 0)
    pos[A.hand].set(0.58 * x, 1.38, 0)
    // the thumb forwards (+z), then the index, middle, ring and little fingers further back
    const z = [0.03, 0.025, 0.008, -0.008, -0.025]
    A.fingers.forEach((chain, j) => chain.forEach((b, k) => pos[b].set(((j === 0 ? 0.6 : 0.67) + 0.025 * k) * x, 1.38, z[j])))
  }
  const left = (b: number) => b >= ARM[0].upper && b < ARM[1].upper
  return {
    nodes: BONES.map(() => null),
    dir: BONES.map((_, b) => (b <= HEAD ? new Vector3(0, 1, 0) : new Vector3(left(b) ? 1 : -1, 0, 0))),
    pos,
    handSide: [new Vector3(0, 0, 1), new Vector3(0, 0, 1)],
    headY: 1.5,
    topY: 1.7,
    chestY: 1.2,
    hipsY: 0.95,
    shoulderWidth: 0.3,
    vrm0: false,
  }
}

const rest = tPose()
const body = armBody(rest)
const DOWN = new Vector3(0, -1, 0)

function put(q: Float32Array, f: number, b: number, r: Quaternion) {
  q.set([r.x, r.y, r.z, r.w], (f * BONE_COUNT + b) * 4)
}

function get(q: Float32Array, f: number, b: number) {
  const k = (f * BONE_COUNT + b) * 4
  return new Quaternion(q[k], q[k + 1], q[k + 2], q[k + 3])
}

/** Local rotations for frames of arm aims: each upper arm and forearm pointing the given ways (left, right), the
 *  hands straight on from the forearms. */
function aim(frames: { upper: [Vector3, Vector3]; fore: [Vector3, Vector3] }[]): Float32Array {
  const q = new Float32Array(frames.length * BONE_COUNT * 4)
  frames.forEach((fr, f) => {
    for (let b = 0; b < BONE_COUNT; b++) put(q, f, b, new Quaternion())
    for (const s of [0, 1] as const) {
      const out = new Vector3(s === 0 ? 1 : -1, 0, 0)
      const up = new Quaternion().setFromUnitVectors(out, fr.upper[s].clone().normalize())
      const lo = new Quaternion().setFromUnitVectors(out, fr.fore[s].clone().normalize())
      put(q, f, ARM[s].upper, up)
      put(q, f, ARM[s].lower, up.clone().invert().multiply(lo))
    }
  })
  return q
}

/** Forearms reaching forwards and in, crossed through each other near the wrists, the left one raised a little (+) or
 *  lowered. tilt turns the cross up at the front, so the arms part forwards and back as well as up and down. */
const crossed = (raise: number, tilt = 0) => {
  const fore = (x: number, y: number) => new Vector3(x, y, 0.6).applyAxisAngle(new Vector3(1, 0, 0), -tilt)
  return {
    upper: [DOWN, DOWN] as [Vector3, Vector3],
    fore: [fore(-0.8, raise), fore(0.8, 0)] as [Vector3, Vector3],
  }
}

/** The forearms' nearest points (left minus right), by sampling along both. */
function forearmGap(q: Float32Array, f: number) {
  const [L, R] = poseArms(q, f, body).pts
  let best = new Vector3(Infinity, 0, 0)
  for (let i = 0; i <= 200; i++) {
    const a = L[1].clone().lerp(L[2], i / 200)
    for (let j = 0; j <= 200; j++) {
      const d = a.clone().sub(R[1].clone().lerp(R[2], j / 200))
      if (d.lengthSq() < best.lengthSq()) best = d
    }
  }
  return best
}

/** The arms themselves (upper arms, forearms, palms): their deepest overlap in a frame (m). */
function armOverlap(q: Float32Array, f: number) {
  const c = armContact(poseArms(q, f, body), body)
  let worst = -Infinity
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (i + j > 0) worst = Math.max(worst, -c.gaps[i * 20 + j])
  return worst
}

/** The video's points for frames of q: the signer's own shoulders, elbows and wrists, with the left elbow and wrist
 *  moved up (+) or down by lift. */
function video(q: Float32Array, frames: number, lift: number) {
  const points = 55
  const pts = new Float32Array(frames * points * 3)
  for (let f = 0; f < frames; f++) {
    const P = poseArms(q, f, body).pts
    for (const s of [0, 1] as const) {
      const up = s === 0 ? lift : 0
      ;[[CLIP_POINT.shoulder[s], 0], [CLIP_POINT.elbow[s], 1], [CLIP_POINT.wrist[s], 2]].forEach(([i, k]) => {
        pts.set([P[s][k].x, P[s][k].y + (k === 0 ? 0 : up), P[s][k].z], (f * points + i) * 3)
      })
    }
  }
  return { pts, points, weights: new Float32Array(frames * 2).fill(1) }
}

function handWorld(q: Float32Array, f: number, s: 0 | 1) {
  const A = ARM[s]
  return get(q, f, SPINE).multiply(get(q, f, CHEST)).multiply(get(q, f, A.upper)).multiply(get(q, f, A.lower))
    .multiply(get(q, f, A.hand))
}

describe('keepArmsApart', () => {
  it('parts forearms crossed through each other until they just touch', () => {
    const frames = Array.from({ length: 9 }, () => crossed(0))
    const q = aim(frames)
    expect(forearmGap(q, 4).length()).toBeLessThan(0.002)
    keepArmsApart(q, 9, body)
    for (let f = 0; f < 9; f++) expect(armOverlap(q, f)).toBeLessThan(0.005)
  })

  it('keeps the same arm on top all through, however the tracking wobbles', () => {
    const frames = Array.from({ length: 12 }, (_, f) => crossed(f % 2 ? 0.02 : -0.02))
    const q = aim(frames)
    keepArmsApart(q, 12, body)
    const sides = Array.from({ length: 12 }, (_, f) => Math.sign(forearmGap(q, f).y))
    expect(new Set(sides).size).toBe(1)
  })

  it('keeps each hand turned as it was, only moving it', () => {
    const q = aim(Array.from({ length: 9 }, () => crossed(0.01)))
    const before = q.slice()
    keepArmsApart(q, 9, body)
    expect(poseArms(q, 4, body).pts[0][2].distanceTo(poseArms(before, 4, body).pts[0][2])).toBeGreaterThan(0.01)
    for (let f = 0; f < 9; f++) {
      for (const s of [0, 1] as const) {
        const a = handWorld(q, f, s)
        const b = handWorld(before, f, s)
        expect(Math.abs(a.dot(b))).toBeGreaterThan(1 - 1e-6)
      }
    }
  })

  it('moves the arm going forwards more than the one going back into the body', () => {
    const q = aim(Array.from({ length: 9 }, () => crossed(0, Math.PI / 4)))
    const before = q.slice()
    keepArmsApart(q, 9, body)
    const moved = (s: 0 | 1) => poseArms(q, 4, body).pts[s][1].clone().sub(poseArms(before, 4, body).pts[s][1])
    const [forwards, back] = moved(0).z > 0 ? [moved(0), moved(1)] : [moved(1), moved(0)]
    expect(back.z).toBeLessThan(0)
    expect(forwards.length()).toBeGreaterThan(1.5 * back.length())
    for (let f = 0; f < 9; f++) expect(armOverlap(q, f)).toBeLessThan(0.005)
  })

  it('keeps on top the arm the video has on top', () => {
    const frames = 9
    // the signer's left forearm a little above the right, but the video's well below it
    const q = aim(Array.from({ length: frames }, () => crossed(0.01)))
    expect(forearmGap(q, 4).y).toBeGreaterThan(0)
    keepArmsApart(q, frames, body, video(q, frames, -0.05))
    for (let f = 0; f < frames; f++) expect(forearmGap(q, f).y).toBeLessThan(0)
  })

  it("doesn't push the arms into each other as they come together from the other side", () => {
    // the left forearm comes up from well below the right, through it, to rest a little above it: as the video has it,
    // so it goes on top, but while it is still below, pushing it up only part of the way would sink it into the right
    const raise = [-0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.3, -0.15, ...Array(10).fill(0.02)]
    const frames = raise.length
    const q = aim(raise.map((r) => crossed(r)))
    expect(armOverlap(q, 0)).toBeLessThan(-0.01)
    keepArmsApart(q, frames, body, video(q, frames, 0.05))
    for (let f = 0; f < frames; f++) expect(armOverlap(q, f)).toBeLessThan(0.005)
    for (let f = 8; f < frames; f++) expect(forearmGap(q, f).y).toBeGreaterThan(0)
  })

  it('parts the arms smoothly as they come together and apart', () => {
    // forearms swing in from pointing straight forwards to crossed, hold, and swing back out
    const T = 31
    const ease = (f: number) => (f < 10 ? f / 10 : f < 21 ? 1 : (30 - f) / 10)
    const frames = Array.from({ length: T }, (_, f) => {
      const k = ease(f)
      return {
        upper: [DOWN, DOWN] as [Vector3, Vector3],
        fore: [new Vector3(-0.8 * k, 0, 1 - 0.4 * k), new Vector3(0.8 * k, 0, 1 - 0.4 * k)] as [Vector3, Vector3],
      }
    })
    const q = aim(frames)
    const before = q.slice()
    keepArmsApart(q, T, body)
    const shift = (f: number, s: 0 | 1) => poseArms(q, f, body).pts[s][1].clone().sub(poseArms(before, f, body).pts[s][1])
    for (let f = 0; f < T; f++) expect(armOverlap(q, f)).toBeLessThan(0.005)
    for (let f = 1; f < T; f++) {
      for (const s of [0, 1] as const) expect(shift(f, s).distanceTo(shift(f - 1, s))).toBeLessThan(0.025)
    }
  })

  it('leaves arms that never touch alone', () => {
    const q = aim(Array.from({ length: 5 }, () => ({
      upper: [DOWN, DOWN] as [Vector3, Vector3],
      fore: [new Vector3(0, 0.2, 1), new Vector3(0, 0.2, 1)] as [Vector3, Vector3],
    })))
    const before = q.slice()
    keepArmsApart(q, 5, body)
    expect(Array.from(q)).toEqual(Array.from(before))
  })
})
