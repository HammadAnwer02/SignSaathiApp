import { describe, expect, it } from 'vitest'
import { Color, Mesh, Object3D } from 'three'
import type { VRM } from '@pixiv/three-vrm'
import { applyLook } from './looks'

function fakeVrm(name: string, materials: string[]) {
  const scene = new Object3D()
  const mats = materials.map((n) => ({ name: n, color: new Color('#ffffff'), shadeColorFactor: new Color('#ffffff') }))
  for (const m of mats) {
    const mesh = new Mesh()
    ;(mesh as unknown as { material: unknown }).material = m
    scene.add(mesh)
  }
  return { vrm: { meta: { name, metaVersion: '1' }, scene } as unknown as VRM, mats }
}

describe('applyLook', () => {
  it('restyles the stand-in sample', () => {
    const { vrm, mats } = fakeVrm('VRM1_Constraint_Twist_Sample', ['Face_00_SKIN', 'HairBack_00_HAIR', 'Shoes_01_CLOTH'])
    expect(applyLook(vrm)).toBe(true)
    expect(mats[0].color.getHexString()).not.toBe('ffffff') // skin
    expect(mats[1].color.getHexString()).not.toBe('ffffff') // hair
    expect(mats[2].color.getHexString()).toBe('ffffff') // shoes are left alone
  })

  it('leaves a custom signer exactly as exported', () => {
    const { vrm, mats } = fakeVrm('Sign Saathi female signer', ['Face_00_SKIN', 'Tops_01_CLOTH'])
    expect(applyLook(vrm)).toBe(false)
    expect(mats.every((m) => m.color.getHexString() === 'ffffff')).toBe(true)
  })
})
