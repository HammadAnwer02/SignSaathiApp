// Restyles for stand-in models, matched by the model's own name, so a custom signer made for Sign Saathi always
// renders exactly as it was exported. A restyle can recolour materials, swap printed cloth for plain colour, hide
// meshes, retouch textures, and dress the signer in a hijab and full sleeves built to fit the model.

import type { Material, Mesh } from 'three'
import type { MToonMaterial, VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import { cloth, makePlain, tint, withOutlines, type Tint } from './wardrobe/fabric'
import { BEARD_FIT, beardSpec, HAIR_FIT, hairSpec, holdMorphs, measureFace, thickenBrows } from './wardrobe/groom'
import { buildHijab, DEFAULT_FIT, type HijabFit } from './wardrobe/hijab'
import { buildShell, sleevesSpec } from './wardrobe/shell'
import { shirtCut, shirtPrint } from './wardrobe/shirt'
import { boneSet, partsOf } from './wardrobe/skinning'
import { bareHands, brownEyes } from './wardrobe/textures'

interface Look {
  /** material name pattern -> colours the material is multiplied by */
  tints?: [RegExp, Tint][]
  /** cloth whose printed pattern is replaced by a plain colour */
  plain?: [RegExp, Tint][]
  /** meshes to hide, by material name (hair under a hijab) */
  hide?: RegExp
  /** iris materials recoloured dark brown */
  brownEyes?: RegExp
  /** paint gloves out of the skin texture */
  bareHands?: boolean
  hijab?: { cloth: Tint; band?: Tint; fit?: Partial<HijabFit> }
  /** full sleeves over bare arms */
  sleeves?: { cloth: Tint; ease: number }
  /** a long-sleeved shirt with a band collar and buttoned placket, in place of whatever top the model wears */
  shirt?: { cloth: Tint }
  /**
   * short hair and a trimmed beard grown from the head's own skin, brows made heavier by a factor, and face morphs
   * held at fixed weights (index, weight: model-specific shapes no expression drives)
   */
  groom?: { hair?: Tint; beard?: Tint; brows?: number; hold?: [number, number][] }
}

// South Asian skin, black hair, dark eyes
const SKIN: Tint = { lit: '#d2a283', shade: '#a3735a' }
const HAIR: Tint = { lit: '#3a2e2b', shade: '#211816' }
const EYES: Tint = { lit: '#5a3d30', shade: '#3b281f' }

// Dark, plain clothes, as interpreters wear, so the hands stand out against them
const ABAYA: Tint = { lit: '#40213a', shade: '#271223' }
const HIJAB: Tint = { lit: '#9b3a64', shade: '#6a2245' }
const HIJAB_BAND: Tint = { lit: '#f2dcae', shade: '#c9a777' }
const SHIRT: Tint = { lit: '#2f5079', shade: '#1c3352' }
const TROUSERS: Tint = { lit: '#3b3b3d', shade: '#232325' }
// a shade lighter than his hair, so the beard's shape reads against his face
const BEARD: Tint = { lit: '#4a3a33', shade: '#2a1e1a' }

const LOOKS: Record<string, Look> = {
  // pixiv's VRM 1.0 sample, standing in for the female signer: hijab, abaya and full sleeves
  VRM1_Constraint_Twist_Sample: {
    tints: [
      [/_SKIN$/, SKIN],
      [/^FaceBrow/, HAIR],
      [/^EyeIris/, EYES],
    ],
    plain: [
      [/^Tops/, ABAYA],
      [/^Bottoms/, ABAYA],
    ],
    hide: /_HAIR\b/,
    hijab: { cloth: HIJAB, band: HIJAB_BAND },
    sleeves: { cloth: ABAYA, ease: 0.007 },
  },
  // pixiv's AvatarSample_C (VRoid Project), standing in for the male signer: a young man with a short back and sides
  // and a trimmed beard, in a plain shirt and trousers
  AvatarSample_C: {
    tints: [
      [/_SKIN$/, SKIN],
      [/FaceBrow/, HAIR],
    ],
    plain: [[/Bottoms/, TROUSERS]],
    // his jacket, his long anime fringe, and the big sparkle in his eyes
    hide: /Tops|_HAIR$|EyeHighlight/,
    brownEyes: /EyeIris/,
    bareHands: true,
    shirt: { cloth: SHIRT },
    // morph 14 lowers his upper lids a little (no expression drives it), so his eyes sit calmer
    groom: { hair: HAIR, beard: BEARD, brows: 1.7, hold: [[14, 0.6]] },
  },
}

export function modelName(vrm: VRM): string {
  const meta = vrm.meta as { name?: string; title?: string }
  return meta.name ?? meta.title ?? ''
}

function meshesOf(vrm: VRM) {
  const list: { mesh: Mesh; materials: Material[] }[] = []
  vrm.scene.traverse((o) => {
    const mesh = o as Mesh
    if (mesh.isMesh) list.push({ mesh, materials: Array.isArray(mesh.material) ? mesh.material : [mesh.material] })
  })
  return list
}

/** Apply the stand-in restyle for this model, if it has one. Returns whether anything changed. */
export function applyLook(vrm: VRM): boolean {
  const look = LOOKS[modelName(vrm)]
  if (!look) return false
  const meshes = meshesOf(vrm)
  // the plain cloth template, taken before any restyle touches it
  const template = meshes.flatMap((m) => m.materials).find((m) => /_CLOTH/.test(m.name) && !(m as MToonMaterial).isOutline)

  for (const { mesh, materials } of meshes) {
    for (const m of materials) {
      const t = look.tints?.find(([re]) => re.test(m.name))?.[1]
      if (t) tint(m, t)
      const p = look.plain?.find(([re]) => re.test(m.name))?.[1]
      if (p) makePlain(m, p)
    }
    if (look.hide && look.hide.test(materials[0]?.name ?? '')) mesh.visible = false
  }

  if (look.brownEyes) {
    const irises = meshes.flatMap((m) => m.materials).filter((m) => look.brownEyes!.test(m.name))
    brownEyes(irises)
  }

  if (!look.bareHands && !look.hijab && !look.sleeves && !look.shirt && !look.groom) return true
  const parts = partsOf(vrm)
  const first = parts[0]
  const skeleton = first?.mesh.skeleton
  if (!first || !skeleton || !vrm.humanoid) return true
  const bone = (name: VRMHumanBoneName) => vrm.humanoid.getRawBoneNode(name)
  const skinParts = parts.filter((p) => /_SKIN/.test(p.material.name) && !/Face/.test(p.material.name))

  if (look.bareHands) bareHands(skinParts, boneSet(skeleton, [bone('leftHand'), bone('rightHand')]))

  const dress = (mesh: Mesh | null) => {
    if (!mesh) return
    const parent = first.mesh.parent ?? vrm.scene
    mesh.position.copy(first.mesh.position)
    mesh.quaternion.copy(first.mesh.quaternion)
    mesh.scale.copy(first.mesh.scale)
    parent.add(mesh)
  }
  const bind = first.mesh.bindMatrix
  if (look.sleeves && template) {
    const surface = cloth(template, look.sleeves.cloth)
    const spec = sleevesSpec(look.sleeves.ease)
    for (const body of skinParts) dress(buildShell(vrm, body, skeleton, bind, withOutlines([surface]), spec))
  }
  if (look.shirt && template) {
    const fit = shirtCut(vrm, skeleton)
    if (fit) {
      const surface = cloth(template, look.shirt.cloth)
      const print = shirtPrint(skinParts, fit)
      if (print) {
        // the print's ground is 80% grey, so brighten the colour to match
        surface.map = surface.shadeMultiplyTexture = print
        surface.color.multiplyScalar(1.25)
        surface.shadeColorFactor.multiplyScalar(1.25)
      }
      const collar = cloth(template, look.shirt.cloth)
      for (const body of skinParts) dress(buildShell(vrm, body, skeleton, bind, withOutlines([surface]), fit.shirt))
      for (const body of skinParts) dress(buildShell(vrm, body, skeleton, bind, withOutlines([collar]), fit.collar))
    }
  }
  if (look.hijab && template) {
    const h = look.hijab
    const surfaces = [cloth(template, h.cloth), ...(h.band ? [cloth(template, h.band)] : [])]
    dress(buildHijab(vrm, parts, skeleton, bind, withOutlines(surfaces), !!h.band, { ...DEFAULT_FIT, ...h.fit }))
  }
  const face = look.groom ? measureFace(vrm, parts, skeleton) : null
  if (look.groom && face) {
    const gr = look.groom
    if (gr.brows) thickenBrows(face.brows, gr.brows)
    if (gr.hold) holdMorphs(vrm, gr.hold)
    if (gr.hair && template) {
      const hair = withOutlines([cloth(template, gr.hair)])
      const spec = hairSpec(face, HAIR_FIT)
      for (const p of [face.skin, ...face.scalp]) dress(buildShell(vrm, p, skeleton, bind, hair, spec))
    }
    if (gr.beard && template) {
      dress(buildShell(vrm, face.skin, skeleton, bind, withOutlines([cloth(template, gr.beard)]), beardSpec(face, BEARD_FIT)))
    }
  }
  return true
}
