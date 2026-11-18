// A plain long-sleeved shirt with a band collar and a buttoned placket, fitted to the body (see shell.ts).

import { CanvasTexture, SRGBColorSpace, Vector3, type Skeleton } from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import type { ShellSpec } from './shell'
import { bindPosition, type Part } from './skinning'

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export interface ShirtCut {
  shirt: ShellSpec
  collar: ShellSpec
  /** bind-space landmarks the print is laid out against */
  neckY: number
  hemY: number
  fwd: number
}

/** How the shirt fits this model: hem a little below the hips, collar at the base of the neck. */
export function shirtCut(vrm: VRM, skeleton: Skeleton): ShirtCut | null {
  const at = (name: VRMHumanBoneName) => bindPosition(skeleton, vrm.humanoid?.getRawBoneNode(name) ?? null)
  const hips = at('hips')
  const neck = at('neck')
  const chest = at('upperChest') ?? at('chest')
  if (!hips || !neck || !chest) return null
  // VRM 0.x models face -z in their own space, VRM 1.0 models +z
  const fwd = vrm.meta.metaVersion === '0' ? -1 : 1
  const hemY = hips.y - 0.07
  const collarLow = neck.y - 0.024
  const collarHigh = neck.y + 0.034

  const shirt: ShellSpec = {
    name: 'Shirt',
    keep: [
      (v) => v.y - hemY,
      // ends at the wrists; zero on the body, so the body stays
      (v) => v.arm - v.hand,
      // up to the base of the neck, where the collar takes over; further out it covers the shoulders' slope
      (v) => Math.max(neck.y + 0.01 - v.y, Math.hypot(v.x - neck.x, v.z - neck.z) - 0.064),
      // never the head: VRoid scalps are body skin, and the shirt would sit on them like a hood under the hair
      (v) => 0.5 - v.head,
    ],
    // falls a little looser over the stomach than across the chest; closer on the arms
    ease: (v) => lerp(lerp(0.009, 0.02, smooth(chest.y, hemY, v.y)), 0.008, Math.min(1, v.arm)),
  }

  const collar: ShellSpec = {
    name: 'Collar',
    keep: [
      (v) => v.y - collarLow,
      (v) => collarHigh - v.y,
      // round the neck only, not out over the shoulders
      (v) => 0.075 - Math.hypot(v.x - neck.x, v.z - neck.z),
      // open at the front, the two ends parting towards the top
      (v) => Math.abs(v.x - neck.x) - (0.005 + 0.3 * (v.y - collarLow)) * smooth(0, 0.02, (v.z - neck.z) * fwd),
    ],
    ease: (v) => 0.011 + 0.01 * smooth(collarLow, collarHigh, v.y),
  }
  return { shirt, collar, neckY: neck.y, hemY, fwd }
}

/**
 * The shirt's print, in the body's UV layout: a placket with buttons down the front, on a light ground the
 * material's colour multiplies. Returns null if the body has no clear front midline.
 */
export function shirtPrint(parts: Part[], cutInfo: ShirtCut, size = 1024): CanvasTexture | null {
  // the front midline of the torso, as UV points from neck to hem
  const line: { y: number; u: number; v: number }[] = []
  for (const p of parts) {
    const uv = p.mesh.geometry.getAttribute('uv')
    if (!uv || !/_SKIN/.test(p.material.name)) continue
    for (let i = 0; i < p.pos.length / 3; i++) {
      const x = p.pos[i * 3]
      const y = p.pos[i * 3 + 1]
      const z = p.pos[i * 3 + 2]
      if (Math.abs(x) > 0.004 || z * cutInfo.fwd < 0.02 || y > cutInfo.neckY || y < cutInfo.hemY) continue
      line.push({ y, u: uv.getX(i), v: uv.getY(i) })
    }
  }
  if (line.length < 4) return null
  // the vertices either side of the midline wobble in UV; average them in 1.5 cm bands, top to bottom
  const bands = new Map<number, { y: number; u: number; v: number; n: number }>()
  for (const p of line) {
    const k = Math.round(p.y / 0.015)
    const b = bands.get(k) ?? { y: 0, u: 0, v: 0, n: 0 }
    b.y += p.y
    b.u += p.u
    b.v += p.v
    b.n++
    bands.set(k, b)
  }
  line.length = 0
  for (const b of bands.values()) line.push({ y: b.y / b.n, u: b.u / b.n, v: b.v / b.n })
  line.sort((a, b) => b.y - a.y)
  if (line.length < 3) return null
  const uvAt = (y: number) => {
    for (let i = 1; i < line.length; i++) {
      if (y >= line[i].y) {
        const a = line[i - 1]
        const b = line[i]
        const t = a.y === b.y ? 0 : (y - a.y) / (b.y - a.y)
        return new Vector3(lerp(a.u, b.u, t) * size, lerp(a.v, b.v, t) * size, 0)
      }
    }
    const last = line[line.length - 1]
    return new Vector3(last.u * size, last.v * size, 0)
  }
  const top = uvAt(line[0].y)
  const bottom = uvAt(line[line.length - 1].y)
  const pxPerM = top.distanceTo(bottom) / Math.max(1e-3, line[0].y - line[line.length - 1].y)
  if (!Number.isFinite(pxPerM) || pxPerM <= 0) return null

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = 'rgb(204,204,204)'
  ctx.fillRect(0, 0, size, size)

  // the placket: two seams either side of the midline
  const dir = bottom.clone().sub(top).normalize()
  const side = new Vector3(-dir.y, dir.x, 0)
  ctx.strokeStyle = 'rgb(150,150,150)'
  ctx.lineWidth = Math.max(1.5, 0.0016 * pxPerM)
  for (const s of [-1, 1]) {
    const off = side.clone().multiplyScalar(s * 0.011 * pxPerM)
    ctx.beginPath()
    for (let y = line[0].y; y >= line[line.length - 1].y; y -= 0.01) {
      const p = uvAt(y).add(off)
      if (y === line[0].y) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
  }
  // buttons, from just under the collar down to near the hem
  const r = Math.max(2, 0.0045 * pxPerM)
  ctx.fillStyle = 'rgb(240,240,240)'
  ctx.lineWidth = Math.max(1, 0.001 * pxPerM)
  for (let y = cutInfo.neckY - 0.045; y > cutInfo.hemY + 0.04; y -= 0.075) {
    const p = uvAt(y)
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.flipY = false
  return tex
}
