// Loads the baked sign index and per-sign motion clips (see pipeline/bake.py for the format).

export type SignKind = 'word' | 'letter-en' | 'letter-ur' | 'number'

export interface SignEntry {
  id: string
  label: string
  en: string[]
  ur: string[]
  kind: SignKind
  frames: number
  /** first source-video frame of the trimmed clip */
  start?: number
  hands: string
  quality: 'good' | 'fair' | 'poor'
}

export interface PhraseEntry {
  en: string[]
  ur: string[]
  seq: string[]
}

export interface SignIndex {
  version: number
  fps: number
  points: { body: string[]; hand: number }
  face: string[]
  source: { name: string; recordedAt: string; via: string; url: string; license: string; changes: string }
  signs: SignEntry[]
  phrases: PhraseEntry[]
}

/** Raw landmark clip: positions in metres, app axes (x = signer's left, y up, z towards viewer). */
export interface Clip {
  id: string
  frames: number
  points: number
  /** frames * points * 3 */
  pts: Float32Array
  /** frames * 2 (left, right hand activity 0..1) */
  weights: Float32Array
  faceChannels: number
  /** frames * faceChannels (0..1) */
  face: Float32Array
}

const base = import.meta.env.BASE_URL

let indexPromise: Promise<SignIndex> | null = null
export function loadIndex(): Promise<SignIndex> {
  indexPromise ??= fetch(`${base}signs/index.json`).then((r) => {
    if (!r.ok) throw new Error(`sign index: HTTP ${r.status}`)
    return r.json() as Promise<SignIndex>
  })
  return indexPromise
}

const clipCache = new Map<string, Promise<Clip>>()
export function loadClip(id: string): Promise<Clip> {
  let p = clipCache.get(id)
  if (!p) {
    p = fetch(`${base}signs/clips/${encodeURIComponent(id)}.bin`)
      .then((r) => {
        if (!r.ok) throw new Error(`clip ${id}: HTTP ${r.status}`)
        return r.arrayBuffer()
      })
      .then((buf) => decodeClip(id, buf))
    p.catch(() => clipCache.delete(id))
    clipCache.set(id, p)
  }
  return p
}

export function decodeClip(id: string, buf: ArrayBuffer): Clip {
  const view = new DataView(buf)
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  if (magic !== 'SSG1') throw new Error(`clip ${id}: bad header`)
  const frames = view.getUint16(4, true)
  const points = view.getUint8(6)
  const faceChannels = view.getUint8(7)
  const pts = new Float32Array(frames * points * 3)
  const weights = new Float32Array(frames * 2)
  const face = new Float32Array(frames * faceChannels)
  let o = 8
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < points * 3; k++, o += 2) pts[f * points * 3 + k] = view.getInt16(o, true) / 10000
    weights[f * 2] = view.getUint8(o) / 255
    weights[f * 2 + 1] = view.getUint8(o + 1) / 255
    o += 4
    for (let k = 0; k < faceChannels; k++, o++) face[f * faceChannels + k] = view.getUint8(o) / 255
  }
  return { id, frames, points, pts, weights, faceChannels, face }
}
