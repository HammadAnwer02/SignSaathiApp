// Cutting triangle meshes along a contour: the face opening of a hijab, the hem of a drape, the cuff of a sleeve.

/**
 * Cut a triangle list along the zero set of a per-vertex field. Triangles that straddle the contour are split so
 * the cut runs exactly along it instead of in stair steps. Each new vertex is made once per edge by `split`
 * (the caller interpolates its attributes from a to b at t) and shared by the triangles on both sides, so the mesh
 * stays connected. Winding is preserved.
 *
 * Returns the new triangle list and, per triangle, whether it lies where the field is >= 0.
 */
export function cut(
  index: ArrayLike<number>,
  field: (v: number) => number,
  split: (a: number, b: number, t: number) => number,
): { index: number[]; inside: boolean[] } {
  const out: number[] = []
  const inside: boolean[] = []
  const made = new Map<number, number>()

  const cross = (a: number, b: number) => {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const key = lo * 0x200000 + hi
    let v = made.get(key)
    if (v === undefined) {
      const fl = field(lo)
      const fh = field(hi)
      v = split(lo, hi, fl / (fl - fh))
      made.set(key, v)
    }
    return v
  }

  for (let i = 0; i + 2 < index.length; i += 3) {
    const tri = [index[i], index[i + 1], index[i + 2]]
    const pos = tri.map((v) => field(v) >= 0)
    const n = (pos[0] ? 1 : 0) + (pos[1] ? 1 : 0) + (pos[2] ? 1 : 0)
    if (n === 0 || n === 3) {
      out.push(tri[0], tri[1], tri[2])
      inside.push(n === 3)
      continue
    }
    // the vertex that sits alone on its side goes first, keeping the winding
    const lone = n === 1 ? pos.indexOf(true) : pos.indexOf(false)
    const p = tri[lone]
    const q = tri[(lone + 1) % 3]
    const r = tri[(lone + 2) % 3]
    const pq = cross(p, q)
    const pr = cross(p, r)
    out.push(p, pq, pr, pq, q, r, pq, r, pr)
    inside.push(n === 1, n !== 1, n !== 1)
  }
  return { index: out, inside }
}

/** The triangles of `index` whose flag is set. */
export function keep(index: number[], flags: boolean[], want = true): number[] {
  const out: number[] = []
  for (let t = 0; t < flags.length; t++) if (flags[t] === want) out.push(index[t * 3], index[t * 3 + 1], index[t * 3 + 2])
  return out
}
