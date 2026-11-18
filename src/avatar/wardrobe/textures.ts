// Retouching a model's own textures when it loads: painting gloves out of the hands, turning coloured eyes brown.

import type { Material, Texture } from 'three'
import type { Part } from './skinning'
import { weightIn } from './skinning'

type Picture = CanvasImageSource & { width: number; height: number }
type Textured = Material & { map?: Texture | null; shadeMultiplyTexture?: Texture | null }

/** Redraw a texture through `paint` and put the result in its place on every material that shows it. */
function repaint(texture: Texture, users: Material[], paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
  const img = texture.image as Picture
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  ctx.drawImage(img, 0, 0)
  paint(ctx, canvas.width, canvas.height)
  for (const m of users as Textured[]) {
    for (const t of [m.map, m.shadeMultiplyTexture]) {
      if (t && (t.image === img || t.image === canvas)) {
        t.image = canvas
        t.needsUpdate = true
      }
    }
  }
}

const luma = (r: number, g: number, b: number) => (0.299 * r + 0.587 * g + 0.114 * b) / 255

/** dark to light: pupil, iris, highlight */
const BROWN: [number, [number, number, number]][] = [
  [0, [16, 10, 7]],
  [0.3, [58, 36, 25]],
  [0.6, [112, 76, 54]],
  [1, [214, 192, 176]],
]

function brownAt(l: number): [number, number, number] {
  for (let i = 1; i < BROWN.length; i++) {
    const [l1, c1] = BROWN[i]
    if (l <= l1 || i === BROWN.length - 1) {
      const [l0, c0] = BROWN[i - 1]
      const t = Math.min(1, Math.max(0, (l - l0) / (l1 - l0)))
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t]
    }
  }
  return BROWN[BROWN.length - 1][1]
}

/** Recolour an iris texture to dark brown, keeping its shading (pupil, ring, catch lights). */
export function brownEyes(materials: Material[]) {
  const done = new Set<unknown>()
  for (const m of materials as Textured[]) {
    const map = m.map
    if (!map || done.has(map.image)) continue
    done.add(map.image)
    repaint(map, materials, (ctx, w, h) => {
      const px = ctx.getImageData(0, 0, w, h)
      const d = px.data
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i]
        const g = d[i + 1]
        const b = d[i + 2]
        const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255
        const l = luma(r, g, b)
        if (chroma < 0.08 && l > 0.8) continue // the white around the irises
        const c = brownAt(l)
        d[i] = c[0]
        d[i + 1] = c[1]
        d[i + 2] = c[2]
      }
      ctx.putImageData(px, 0, 0)
    })
  }
}

/** Paint gloves (dark, unsaturated texels) out of the hands' part of the skin texture, in the hands' own skin colour. */
export function bareHands(skinParts: Part[], hands: Set<number>) {
  const byTexture = new Map<Texture, { users: Material[]; tris: number[] }>()
  for (const p of skinParts) {
    const map = (p.material as Textured).map
    const uv = p.mesh.geometry.getAttribute('uv')
    const index = p.mesh.geometry.index
    if (!map || !uv || !index) continue
    const hw = weightIn(p.mesh.geometry, hands)
    let entry = byTexture.get(map)
    if (!entry) byTexture.set(map, (entry = { users: [], tris: [] }))
    entry.users.push(...(Array.isArray(p.mesh.material) ? p.mesh.material : [p.mesh.material]))
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i)
      const b = index.getX(i + 1)
      const c = index.getX(i + 2)
      // anything the hand moves, so no glove shows past the cuff
      if (Math.max(hw[a], hw[b], hw[c]) < 0.3) continue
      for (const v of [a, b, c]) entry.tris.push(uv.getX(v), uv.getY(v))
    }
  }

  for (const [map, { users, tris }] of byTexture) {
    if (!tris.length) continue
    repaint(map, users, (ctx, w, h) => {
      // where the hands are in the texture, slightly grown so filtering at the edges picks up skin too
      const mask = document.createElement('canvas')
      mask.width = w
      mask.height = h
      const mc = mask.getContext('2d', { willReadFrequently: true })
      if (!mc) return
      let x0 = w
      let y0 = h
      let x1 = 0
      let y1 = 0
      mc.fillStyle = mc.strokeStyle = '#fff'
      mc.lineWidth = 4
      mc.lineJoin = 'round'
      mc.beginPath()
      for (let i = 0; i < tris.length; i += 6) {
        for (let k = 0; k < 3; k++) {
          const x = tris[i + k * 2] * w
          const y = tris[i + k * 2 + 1] * h
          if (k === 0) mc.moveTo(x, y)
          else mc.lineTo(x, y)
          x0 = Math.min(x0, x)
          y0 = Math.min(y0, y)
          x1 = Math.max(x1, x)
          y1 = Math.max(y1, y)
        }
        mc.closePath()
      }
      mc.fill()
      mc.stroke()
      const bx = Math.max(0, Math.floor(x0) - 4)
      const by = Math.max(0, Math.floor(y0) - 4)
      const bw = Math.min(w, Math.ceil(x1) + 4) - bx
      const bh = Math.min(h, Math.ceil(y1) + 4) - by
      if (bw <= 0 || bh <= 0) return
      const m = mc.getImageData(bx, by, bw, bh).data
      const px = ctx.getImageData(bx, by, bw, bh)
      const d = px.data

      // the hands' own bare skin, averaged, to paint with
      let sr = 0
      let sg = 0
      let sb = 0
      let sn = 0
      for (let i = 0; i < d.length; i += 4) {
        if (m[i] < 128) continue
        const l = luma(d[i], d[i + 1], d[i + 2])
        if (l > 0.72 && d[i] > d[i + 2] + 12) {
          sr += d[i]
          sg += d[i + 1]
          sb += d[i + 2]
          sn++
        }
      }
      const skin = sn ? [sr / sn, sg / sn, sb / sn] : [250, 222, 204]

      for (let i = 0; i < d.length; i += 4) {
        if (m[i] < 128) continue
        const r = d[i]
        const g = d[i + 1]
        const b = d[i + 2]
        const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255
        const l = luma(r, g, b)
        if (chroma > 0.16) continue
        // fully dark glove becomes skin; the soft edge of the glove blends in
        const k = Math.min(1, Math.max(0, (0.66 - l) / 0.22))
        if (k <= 0) continue
        d[i] = r + (skin[0] - r) * k
        d[i + 1] = g + (skin[1] - g) * k
        d[i + 2] = b + (skin[2] - b) * k
      }
      ctx.putImageData(px, bx, by)
    })
  }
}
