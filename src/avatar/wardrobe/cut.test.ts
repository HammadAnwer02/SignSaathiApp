import { describe, expect, it } from 'vitest'
import { cut, keep } from './cut'

/** a unit square as two triangles, plus a 3x3 grid version of it */
function grid(n: number) {
  const pos: number[] = []
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i / n, j / n)
  const index: number[] = []
  const at = (i: number, j: number) => j * (n + 1) + i
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) index.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1))
  }
  return { pos, index }
}

const area = (pos: number[], index: number[]) => {
  let s = 0
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]]
    s += ((pos[b * 2] - pos[a * 2]) * (pos[c * 2 + 1] - pos[a * 2 + 1]) - (pos[c * 2] - pos[a * 2]) * (pos[b * 2 + 1] - pos[a * 2 + 1])) / 2
  }
  return s
}

function cutAlong(n: number, field: (x: number, y: number) => number) {
  const { pos, index } = grid(n)
  const split = (a: number, b: number, t: number) => {
    pos.push(pos[a * 2] + (pos[b * 2] - pos[a * 2]) * t, pos[a * 2 + 1] + (pos[b * 2 + 1] - pos[a * 2 + 1]) * t)
    return pos.length / 2 - 1
  }
  const f = (v: number) => field(pos[v * 2], pos[v * 2 + 1])
  const r = cut(index, f, split)
  return { pos, r, f, kept: keep(r.index, r.inside), dropped: keep(r.index, r.inside, false) }
}

describe('cut', () => {
  it('splits exactly along a straight line and keeps the winding', () => {
    const { pos, r, f, kept, dropped } = cutAlong(3, (x) => x - 0.4)
    expect(area(pos, kept)).toBeCloseTo(0.6, 6)
    expect(area(pos, dropped)).toBeCloseTo(0.4, 6)
    // every kept triangle lies on the right side; every dropped one on the left
    for (const v of kept) expect(f(v)).toBeGreaterThanOrEqual(-1e-9)
    for (const v of dropped) expect(f(v)).toBeLessThanOrEqual(1e-9)
    expect(r.inside.length * 3).toBe(r.index.length)
  })

  it('shares each new vertex between the triangles either side of an edge', () => {
    const { pos } = cutAlong(4, (x, y) => (x - 0.5) ** 2 + (y - 0.5) ** 2 - 0.09)
    // the square has 25 corners; a closed curve crossing the grid adds one vertex per crossed edge, not per triangle
    const added = pos.length / 2 - 25
    const seen = new Set<string>()
    for (let v = 25; v < pos.length / 2; v++) seen.add(`${pos[v * 2].toFixed(9)},${pos[v * 2 + 1].toFixed(9)}`)
    expect(seen.size).toBe(added)
  })

  it('leaves a mesh alone when the contour misses it', () => {
    const { r, pos } = cutAlong(2, (x) => x + 1)
    expect(r.inside.every(Boolean)).toBe(true)
    expect(pos.length / 2).toBe(9)
  })
})
