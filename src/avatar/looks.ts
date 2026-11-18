// Restyles for stand-in models, matched by the model's own name, so a custom signer made for Sign Saathi
// always renders exactly as it was exported.

import { Color, type Material, type Mesh } from 'three'
import type { VRM } from '@pixiv/three-vrm'

/** lit and shade colours an MToon material is multiplied by */
type Tint = { lit: string; shade: string }

interface Look {
  /** material name pattern -> tint */
  tints: [RegExp, Tint][]
}

type MToonish = Material & { color?: Color; shadeColorFactor?: Color }

const LOOKS: Record<string, Look> = {
  // pixiv's VRM 1.0 sample, standing in for the female signer: South Asian skin, black hair, dark eyes,
  // and the plain dark top interpreters wear so the hands read clearly
  VRM1_Constraint_Twist_Sample: {
    tints: [
      [/_SKIN$/, { lit: '#d2a283', shade: '#a3735a' }],
      [/_HAIR$/, { lit: '#3a2e2b', shade: '#211816' }],
      [/^FaceBrow/, { lit: '#3a2e2b', shade: '#211816' }],
      [/^EyeIris/, { lit: '#5a3d30', shade: '#3b281f' }],
      [/^Tops/, { lit: '#0b4157', shade: '#04212d' }],
    ],
  },
}

export function modelName(vrm: VRM): string {
  const meta = vrm.meta as { name?: string; title?: string }
  return meta.name ?? meta.title ?? ''
}

/** Apply the stand-in restyle for this model, if it has one. Returns whether anything changed. */
export function applyLook(vrm: VRM): boolean {
  const look = LOOKS[modelName(vrm)]
  if (!look) return false
  vrm.scene.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const tint = look.tints.find(([re]) => re.test(m.name))?.[1]
      if (!tint) continue
      const mt = m as MToonish
      mt.color?.set(tint.lit)
      mt.shadeColorFactor?.set(tint.shade)
    }
  })
  return true
}
