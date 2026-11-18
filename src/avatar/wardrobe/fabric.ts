// Plain-coloured toon cloth, made from one of the model's own MToon materials so it shades like the rest of it.

import { BackSide, BufferGeometry, DoubleSide, type Color, type Material } from 'three'
import type { MToonMaterial } from '@pixiv/three-vrm'

/** lit and shade colours of a toon material */
export interface Tint {
  lit: string
  shade: string
}

type Tintable = Material & { color?: Color; shadeColorFactor?: Color }

const TEXTURE_SLOTS = [
  'map',
  'shadeMultiplyTexture',
  'shadingShiftTexture',
  'matcapTexture',
  'rimMultiplyTexture',
  'normalMap',
  'emissiveMap',
  'outlineWidthMultiplyTexture',
  'uvAnimationMaskTexture',
] as const

export function tint(material: Material, t: Tint) {
  const m = material as Tintable
  m.color?.set(t.lit)
  m.shadeColorFactor?.set(t.shade)
}

/** Drop a material's printed pattern and give it a flat colour, in place. */
export function makePlain(material: Material, t: Tint) {
  const slots = material as unknown as Record<string, unknown>
  for (const k of TEXTURE_SLOTS) if (slots[k]) slots[k] = null
  tint(material, t)
  material.needsUpdate = true
}

/** A new plain-coloured cloth material cut from `template` (an MToon cloth of the same model). */
export function cloth(template: Material, t: Tint): MToonMaterial {
  const m = template.clone() as MToonMaterial
  m.name = `Wardrobe ${t.lit}`
  makePlain(m, t)
  m.side = DoubleSide
  return m
}

/** The materials and draw groups a three-vrm mesh uses: each surface followed by its outline, if it has one. */
export function withOutlines(surfaces: MToonMaterial[]): Material[] {
  const out: Material[] = []
  for (const s of surfaces) {
    out.push(s)
    if (s.outlineWidthMode !== 'none' && s.outlineWidthFactor > 0) {
      const o = s.clone()
      o.name = `${s.name} (Outline)`
      o.isOutline = true
      o.side = BackSide
      // a deeper shade of the cloth itself, like the model's own outlines
      o.outlineColorFactor.copy(s.shadeColorFactor).multiplyScalar(0.45)
      out.push(o)
    }
  }
  return out
}

/** Draw `ranges[k]` (start, count in the index) with surface k and, when it has one, its outline. */
export function addGroups(geometry: BufferGeometry, materials: Material[], ranges: [number, number][]) {
  let m = 0
  ranges.forEach(([start, count]) => {
    geometry.addGroup(start, count, m++)
    if ((materials[m] as MToonMaterial | undefined)?.isOutline) geometry.addGroup(start, count, m++)
  })
}
