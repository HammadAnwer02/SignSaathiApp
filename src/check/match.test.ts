import { readFileSync } from 'node:fs'
import { describe as group, expect, it } from 'vitest'
import { decodeClip, type Clip } from '../signs/data'
import { Attempt, compare, MARGIN, PASS, rivalCost, signFeats } from './match'

const FPS = 25
const BODY_N = 13
const PAIRS = [
  [1, 2],
  [3, 4],
  [5, 6],
  [7, 8],
  [9, 10],
  [11, 12],
]

function clip(id: string): Clip {
  const b = readFileSync(new URL(`../../public/signs/clips/${id}.bin`, import.meta.url))
  return decodeClip(id, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
}

/** the clip's mirror image: reflected left to right, so each hand does the other's part */
function mirrored(c: Clip): Clip {
  const pts = c.pts.slice()
  const weights = c.weights.slice()
  const P = c.points * 3
  for (let f = 0; f < c.frames; f++) {
    const at = f * P
    for (let i = 0; i < c.points; i++) pts[at + i * 3] = -pts[at + i * 3]
    const body = pts.slice(at, at + P)
    for (const [a, b] of PAIRS) {
      pts.set(body.subarray(b * 3, b * 3 + 3), at + a * 3)
      pts.set(body.subarray(a * 3, a * 3 + 3), at + b * 3)
    }
    pts.set(body.subarray((BODY_N + 21) * 3, (BODY_N + 42) * 3), at + BODY_N * 3)
    pts.set(body.subarray(BODY_N * 3, (BODY_N + 21) * 3), at + (BODY_N + 21) * 3)
    weights[f * 2] = c.weights[f * 2 + 1]
    weights[f * 2 + 1] = c.weights[f * 2]
  }
  return { ...c, pts, weights }
}

/** the clip played back as if the camera had followed it, `ms` apart, with `rest` frames of hands down either side */
function attemptOf(c: Clip, ms = 1000 / FPS, rest = 0): Attempt {
  const a = new Attempt()
  const P = c.points * 3
  // app axes back to MediaPipe's: (x, -y, -z) undoes itself
  const toMp = (src: Float32Array) => src.map((v, i) => (i % 3 === 0 ? v : -v))
  let t = 0
  const body0 = toMp(c.pts.slice(0, BODY_N * 3))
  for (let k = 0; k < rest; k++, t += ms) a.add(t, body0, [null, null])
  for (let f = 0; f < c.frames; f++, t += ms) {
    const at = f * P
    const hand = (s: number) =>
      c.weights[f * 2 + s] >= 0.5 ? toMp(c.pts.slice(at + (BODY_N + s * 21) * 3, at + (BODY_N + (s + 1) * 21) * 3)) : null
    a.add(t, toMp(c.pts.slice(at, at + BODY_N * 3)), [hand(0), hand(1)])
  }
  for (let k = 0; k < rest; k++, t += ms) a.add(t, body0, [null, null])
  return a
}

const FIRST_WORDS = ['welcome_reception', 'good', 'not', 'name', 'what', 'i_me', 'aap', 'help']

group('sign check', () => {
  it('finds a sign in itself, with rest either side', () => {
    for (const id of FIRST_WORDS) {
      const c = clip(id)
      const v = compare(signFeats(c, FPS), attemptOf(c, 1000 / FPS, 20).series())
      // not 0: the attempt is steadied a little more than the recording was
      expect(v.cost, id).toBeLessThan(0.3)
    }
  })

  it('allows a slower pace', () => {
    for (const id of FIRST_WORDS) {
      const c = clip(id)
      expect(compare(signFeats(c, FPS), attemptOf(c, 2000 / FPS).series()).cost, id).toBeLessThan(0.3)
      expect(compare(signFeats(c, FPS), attemptOf(c, 2600 / FPS).series()).cost, id).toBeLessThan(0.3)
    }
  })

  it('counts the mirror image, signed with the other hand', () => {
    for (const id of FIRST_WORDS) {
      const c = clip(id)
      const v = compare(signFeats(c, FPS), attemptOf(mirrored(c)).series())
      expect(v.cost, id).toBeLessThan(0.3)
      // a sign made with both hands the same can match either way round
      if (c.weights.some((w, i) => i % 2 === 0 && w > 0.5) !== c.weights.some((w, i) => i % 2 === 1 && w > 0.5))
        expect(v.mirrored, id).toBe(true)
    }
  })

  it('tells the first words apart', () => {
    const signs = FIRST_WORDS.map((id) => signFeats(clip(id), FPS))
    for (const [k, id] of FIRST_WORDS.entries()) {
      const tries = attemptOf(clip(id)).series()
      const costs = signs.map((s) => compare(s, tries).cost)
      const others = costs.filter((_, j) => j !== k)
      expect(Math.min(...others), id).toBeGreaterThan(costs[k] + 0.3)
    }
  })

  it('lets another sign that fits the same signing better win', () => {
    // letters that differ by a finger or two (but not i and j: j is i with a hook drawn, so "i" is in it)
    const ids = ['m', 'n', 'r', 'u', 'v'].map((c) => `${c}_single-handed-letter`)
    const signs = ids.map((id) => signFeats(clip(id), FPS))
    let close = 0
    for (const [k, id] of ids.entries()) {
      const tries = attemptOf(clip(id)).series()
      for (const [j, other] of ids.entries()) {
        const v = compare(signs[j], tries)
        if (j === k || v.cost > PASS) continue
        // asked for `other` while signing `id`, and it passes on its own: `id` explains the signing better
        close++
        expect(rivalCost(signs[k], tries, v), `${other} signed as ${id}`).toBeLessThan(v.cost - MARGIN)
      }
    }
    expect(close).toBeGreaterThan(0)
  })

  it('does not count hands that never come up', () => {
    const c = clip('good')
    const a = new Attempt()
    const body = c.pts.slice(0, BODY_N * 3).map((v, i) => (i % 3 === 0 ? v : -v))
    for (let t = 0; t < 4000; t += 40) a.add(t, body, [null, null])
    expect(compare(signFeats(c, FPS), a.series()).cost).toBeGreaterThan(1)
  })
})
