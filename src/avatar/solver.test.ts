import { describe, expect, it } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import { BONE_COUNT } from './rig'
import { bendTwist, bridge, despike, limitCone, limitJoint, planTwist, smoothTwist, type Joint } from './solver'

const RAD = Math.PI / 180

// a finger's middle joint: the parent bone points along +x, the knuckle line runs along +z and the palm faces -y
const hinge: Joint = {
  u: new Vector3(1, 0, 0),
  a: new Vector3(0, 0, 1),
  w: new Vector3(0, -1, 0),
  flex: [-5 * RAD, 110 * RAD],
  spread: [-3 * RAD, 3 * RAD],
}

/** the child bone's direction for a bend (towards the palm) and a sideways spread, in degrees */
function dir(flexDeg: number, spreadDeg = 0) {
  const f = flexDeg * RAD
  const s = spreadDeg * RAD
  return new Vector3(Math.cos(s) * Math.cos(f), -Math.cos(s) * Math.sin(f), Math.sin(s))
}

function angles(t: Vector3) {
  return {
    flex: Math.atan2(t.dot(hinge.w), t.dot(hinge.u)) / RAD,
    spread: Math.asin(t.dot(hinge.a)) / RAD,
  }
}

describe('limitJoint', () => {
  it('leaves a bend the joint can make alone', () => {
    const t = limitJoint(dir(60), hinge)
    expect(angles(t).flex).toBeCloseTo(60, 5)
    expect(angles(t).spread).toBeCloseTo(0, 5)
  })

  it('keeps a joint bent a little backwards near straight', () => {
    // mirrored about the -5 deg limit
    expect(angles(limitJoint(dir(-12), hinge)).flex).toBeCloseTo(2, 5)
  })

  it('reads a joint bent far backwards as bent forwards, as tracking with the depth flipped would see it', () => {
    expect(angles(limitJoint(dir(-80), hinge)).flex).toBeCloseTo(70, 5)
  })

  it('moves smoothly through the limit', () => {
    const near = (deg: number) => angles(limitJoint(dir(deg), hinge)).flex
    expect(near(-4.9) - near(-5.1)).toBeLessThan(0.3)
  })

  it('takes the sideways bend out of a hinge and keeps its bend', () => {
    const a = angles(limitJoint(dir(40, 30), hinge))
    expect(a.spread).toBeCloseTo(3, 5)
    expect(a.flex).toBeCloseTo(40, 5)
  })

  it('stops a joint bending further than it can', () => {
    expect(angles(limitJoint(dir(150), hinge)).flex).toBeCloseTo(110, 5)
  })
})

describe('despike', () => {
  /** one bone turning about z by these angles (degrees), one frame each */
  function track(deg: number[]) {
    const q = new Float32Array(deg.length * 4)
    deg.forEach((a, f) => {
      const r = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), a * RAD)
      q.set([r.x, r.y, r.z, r.w], f * 4)
    })
    return q
  }
  const turned = (q: Float32Array) =>
    Array.from({ length: q.length / 4 }, (_, f) => (2 * Math.atan2(q[f * 4 + 2], q[f * 4 + 3])) / RAD)

  it('puts back a one-frame glitch', () => {
    const q = track([10, 10, 10, 10, 90, 10, 10, 10, 10])
    despike(q, 9, 0, 1)
    turned(q).forEach((a) => expect(a).toBeCloseTo(10, 3))
  })

  it('puts back a glitch lasting three frames', () => {
    const q = track([10, 10, 10, 10, 80, 85, 80, 10, 10, 10, 10])
    despike(q, 11, 0, 1)
    turned(q).forEach((a) => expect(a).toBeCloseTo(10, 3))
  })

  it('keeps a quick handshape change', () => {
    const deg = [0, 0, 0, 0, 0, 90, 90, 90, 90, 90]
    const q = track(deg)
    despike(q, deg.length, 0, 1)
    turned(q).forEach((a, f) => expect(a).toBeCloseTo(deg[f], 3))
  })

  it('keeps fingers wiggling', () => {
    const deg = Array.from({ length: 18 }, (_, f) => 30 * Math.sin((2 * Math.PI * f) / 6))
    const q = track(deg)
    despike(q, deg.length, 0, 1)
    turned(q).forEach((a, f) => expect(a).toBeCloseTo(deg[f], 3))
  })
})

describe('limitCone', () => {
  const axis = new Vector3(1, 0, 0)
  it('leaves a direction inside the cone alone', () => {
    const t = new Vector3(Math.cos(RAD * 50), Math.sin(RAD * 50), 0)
    expect(limitCone(t.clone(), axis, 80 * RAD).distanceTo(t)).toBeLessThan(1e-9)
  })
  it('brings a direction outside the cone back to its edge, on the same side', () => {
    const t = limitCone(new Vector3(Math.cos(RAD * 120), 0, Math.sin(RAD * 120)), axis, 80 * RAD)
    expect(Math.acos(t.dot(axis)) / RAD).toBeCloseTo(80, 5)
    expect(t.y).toBeCloseTo(0, 9)
    expect(t.z).toBeGreaterThan(0)
  })
})

describe('thumb twist', () => {
  const d1 = new Vector3(1, 0, 0)
  const hinge = new Vector3(0, 0, 1)
  /** a thumb whose two outer joints each bend bendDeg about an axis turned turnDeg from the hinge, about d1 */
  function thumb(turnDeg: number, bendDeg: number) {
    const axis = hinge.clone().applyAxisAngle(d1, turnDeg * RAD)
    const d2 = d1.clone().applyAxisAngle(axis, bendDeg * RAD)
    const d3 = d2.clone().applyAxisAngle(axis, bendDeg * RAD)
    return bendTwist(d1, d2, d3, hinge, [0, 0])
  }
  /** an angle as an axis: folded into (-90, 90] degrees */
  const axial = (rad: number) => {
    const d = rad / RAD
    return d - 180 * Math.round(d / 180)
  }

  it('reads how far the thumb must turn for its hinge to match the bend', () => {
    const [twist, trust] = thumb(30, 40)
    expect(axial(twist)).toBeCloseTo(30, 5)
    expect(trust).toBeCloseTo(1, 5)
  })

  it('reads the same axis from a thumb bent back', () => {
    expect(axial(thumb(30, -40)[0])).toBeCloseTo(30, 5)
  })

  it("doesn't trust a straight thumb", () => {
    expect(thumb(30, 0)[1]).toBe(0)
    expect(thumb(30, 3)[1]).toBe(0)
  })

  const deg = (a: Float32Array) => Array.from(a, (x) => x / RAD)
  const ones = (n: number) => new Array(n).fill(1)

  it('keeps a steady twist', () => {
    deg(smoothTwist(new Array(20).fill(40 * RAD), ones(20))).forEach((a) => expect(a).toBeCloseTo(40, 3))
  })

  it('reads curls and bent-back frames about the same axis as one twist', () => {
    const raw = Array.from({ length: 20 }, (_, f) => (f % 2 ? 40 : -140) * RAD)
    deg(smoothTwist(raw, ones(20))).forEach((a) => expect(a).toBeCloseTo(40, 3))
  })

  it('stays untwisted when the thumb is never bent', () => {
    deg(smoothTwist(new Array(10).fill(70 * RAD), new Array(10).fill(0))).forEach((a) => expect(a).toBe(0))
  })

  it('outvotes a one-frame misreading', () => {
    const raw = new Array(21).fill(40 * RAD)
    raw[10] = 120 * RAD
    expect(deg(smoothTwist(raw, ones(21)))[10]).toBeCloseTo(40, -1)
  })

  it('never flips over between frames, nor turns more than a quarter turn', () => {
    // readings either side of a quarter turn are the same axis, a few degrees apart
    const raw = Array.from({ length: 30 }, (_, f) => (f % 2 ? 85 : -85) * RAD)
    const out = deg(smoothTwist(raw, ones(30)))
    for (let f = 1; f < out.length; f++) expect(Math.abs(out[f] - out[f - 1])).toBeLessThan(10)
    out.forEach((a) => expect(Math.abs(a)).toBeLessThanOrEqual(90 + 1e-4))
  })

  it('eases back to plain aiming where the thumb straightens', () => {
    const raw = new Array(30).fill(50 * RAD)
    const trust = Array.from({ length: 30 }, (_, f) => (f < 10 ? 1 : 0))
    const out = deg(smoothTwist(raw, trust))
    expect(out[5]).toBeCloseTo(50, 3)
    expect(out[29]).toBe(0)
    for (let f = 1; f < out.length; f++) expect(Math.abs(out[f] - out[f - 1])).toBeLessThan(15)
  })
})

describe('forearm twist plan', () => {
  const plan = (readDeg: number[], weight = readDeg.map(() => 1)) =>
    Array.from(planTwist(readDeg.map((d) => d * RAD), weight), (r) => r / RAD)

  it('keeps turning the same way where the reading passes half a turn, as a palm turning up does', () => {
    const out = plan([150, 170, -170, -150, -130])
    for (let f = 1; f < out.length; f++) expect(out[f] - out[f - 1]).toBeCloseTo(20, 3)
  })

  it('moves the whole clip by whole turns so the signing frames sit near no turn at all', () => {
    // a hand turning steadily a full turn and a half reads back round to where it started
    const read = Array.from({ length: 13 }, (_, f) => f * 45)
    const out = plan(read.map((d) => ((d + 180) % 360) - 180))
    const mean = out.reduce((a, b) => a + b, 0) / out.length
    expect(Math.abs(mean)).toBeLessThanOrEqual(180)
    for (let f = 1; f < out.length; f++) expect(out[f] - out[f - 1]).toBeCloseTo(45, 3)
  })

  it('holds the turn before and after the signing frames, while the arm eases to rest', () => {
    const out = plan([80, 60, 10, 20, 30, -40, -90], [0.2, 0.5, 1, 1, 1, 0.5, 0.2])
    expect(out.map((d) => Math.round(d))).toEqual([10, 10, 10, 20, 30, 30, 30])
  })

  it('goes straight across frames it could not read, the shorter way round', () => {
    expect(plan([0, NaN, NaN, 30]).map((d) => Math.round(d))).toEqual([0, 10, 20, 30])
    const out = plan([170, NaN, -170])
    expect(out[1] - out[0]).toBeCloseTo(10, 3)
    expect(out[2] - out[1]).toBeCloseTo(10, 3)
  })
})

describe('bridge', () => {
  const frames = 6
  const bone = 3
  const turnZ = (deg: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), deg * RAD)
  const track = (qs: Quaternion[]) => {
    const q = new Float32Array(frames * BONE_COUNT * 4)
    qs.forEach((r, f) => q.set([r.x, r.y, r.z, r.w], (f * BONE_COUNT + bone) * 4))
    return q
  }
  const angleAt = (q: Float32Array, f: number) => {
    const k = (f * BONE_COUNT + bone) * 4
    return (2 * Math.atan2(q[k + 2], q[k + 3])) / RAD
  }

  it('turns evenly from the frame before to the frame after in place of the flagged frames', () => {
    const q = track([turnZ(0), turnZ(10), turnZ(170), turnZ(-60), turnZ(40), turnZ(50)])
    bridge(q, frames, bone, [0, 0, 1, 1, 0, 0])
    expect([0, 1, 2, 3, 4, 5].map((f) => Math.round(angleAt(q, f)))).toEqual([0, 10, 20, 30, 40, 50])
  })

  it('holds the frame there is when the flagged frames reach the end of the clip', () => {
    const q = track([turnZ(90), turnZ(0), turnZ(25), turnZ(-70), turnZ(120), turnZ(5)])
    bridge(q, frames, bone, [1, 1, 0, 0, 1, 1])
    expect([0, 1, 4, 5].map((f) => Math.round(angleAt(q, f)))).toEqual([25, 25, -70, -70])
  })

  it('leaves every other bone alone', () => {
    const q = track([turnZ(0), turnZ(80), turnZ(0), turnZ(0), turnZ(0), turnZ(0)])
    q[(1 * BONE_COUNT + bone + 1) * 4 + 3] = 0.5
    bridge(q, frames, bone, [0, 1, 0, 0, 0, 0])
    expect(q[(1 * BONE_COUNT + bone + 1) * 4 + 3]).toBe(0.5)
  })
})
