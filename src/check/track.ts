// Follows your hands and upper body in the camera picture, on the device itself with Google's MediaPipe: the picture
// never leaves it. Two ways to do it: the holistic model the dictionary's signs were measured with, or a lighter pair
// of models (body, hands) for phones the holistic one is too slow on. This runs in a worker (tracker.worker.ts), so
// it uses MediaPipe's ES-module runtime.

import type { HandLandmarkerResult, Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url'
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url'

/** the body points the signs were recorded with, as MediaPipe pose indices (pipeline/bake.py) */
const BODY = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24]

export type TrackerKind = 'holistic' | 'lite'
export type Delegate = 'GPU' | 'CPU'

/** What one camera frame shows. */
export interface Seen {
  /** the body points (BODY) in metres from the hips, MediaPipe's axes: x to the person's left, y down, z away */
  body: Float32Array | null
  /** each of the person's own hands [left, right]: 21 points in metres around the hand's middle, same axes */
  hands: [Float32Array | null, Float32Array | null]
  /** the same hands in the picture (x, y from 0 to 1), for drawing */
  pics: [Float32Array | null, Float32Array | null]
  /** both shoulders are in the picture */
  framed: boolean
}

export interface Tracker {
  readonly kind: TrackerKind
  readonly delegate: Delegate
  /** follow one frame; `t` (ms) must go up from one call to the next */
  see(frame: TexImageSource, t: number): Seen
  close(): void
}

const abs = (path: string) => new URL(path, self.location.href).href
const model = (name: string) => abs(`${import.meta.env.BASE_URL}models/${name}`)

function flat(points: (Landmark | NormalizedLandmark)[] | undefined, dims = 3): Float32Array | null {
  if (!points?.length) return null
  const out = new Float32Array(points.length * dims)
  points.forEach((p, i) => {
    out[i * dims] = p.x
    out[i * dims + 1] = p.y
    if (dims === 3) out[i * dims + 2] = p.z
  })
  return out
}

function bodyOf(world: Landmark[] | undefined): Float32Array | null {
  return world?.length ? flat(BODY.map((i) => world[i])) : null
}

function framed(pic: NormalizedLandmark[] | undefined): boolean {
  return !!pic && [11, 12].every((i) => (pic[i].visibility ?? 1) > 0.5 && pic[i].x > 0 && pic[i].x < 1 && pic[i].y < 1)
}

/** Which of the person's hands each found hand is: the one whose wrist the body model puts nearest, or failing a
 *  body, the hand model's own guess. */
function sidesOf(h: HandLandmarkerResult, pic: NormalizedLandmark[] | undefined): number[] {
  const guess = h.handedness.map((c) => (c[0]?.categoryName === 'Left' ? 0 : 1))
  if (!pic || !h.landmarks.length) return guess
  const d = (k: number, side: number) => {
    const w = h.landmarks[k][0]
    const b = pic[15 + side]
    return Math.hypot(w.x - b.x, w.y - b.y)
  }
  if (h.landmarks.length === 1) return [d(0, 0) <= d(0, 1) ? 0 : 1]
  return d(0, 0) + d(1, 1) <= d(0, 1) + d(1, 0) ? [0, 1] : [1, 0]
}

let factory: unknown

/** MediaPipe imports its runtime module for each task it makes and takes the factory the module left on `self` —
 *  but a module only runs once, so from the second task on, put the factory back first. */
async function runtimeReady() {
  factory ??= ((await import(/* @vite-ignore */ abs(wasmLoaderPath))) as { default: unknown }).default
  ;(self as unknown as { ModuleFactory?: unknown }).ModuleFactory = factory
}

export async function createTracker(kind: TrackerKind = 'holistic', delegate: Delegate = 'GPU'): Promise<Tracker> {
  const mp = await import('@mediapipe/tasks-vision')
  const files = { wasmLoaderPath: abs(wasmLoaderPath), wasmBinaryPath: abs(wasmBinaryPath) }
  if (kind === 'holistic') {
    await runtimeReady()
    const h = await mp.HolisticLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: model('holistic_landmarker.task'), delegate },
      runningMode: 'VIDEO',
      outputFaceBlendshapes: false,
      outputPoseSegmentationMasks: false,
    })
    return {
      kind,
      delegate,
      see(frame, t) {
        const r = h.detectForVideo(frame, t)
        return {
          body: bodyOf(r.poseWorldLandmarks[0]),
          hands: [flat(r.leftHandWorldLandmarks[0]), flat(r.rightHandWorldLandmarks[0])],
          pics: [flat(r.leftHandLandmarks[0], 2), flat(r.rightHandLandmarks[0], 2)],
          framed: framed(r.poseLandmarks[0]),
        }
      },
      close: () => h.close(),
    }
  }

  // one after the other: both load the same runtime
  await runtimeReady()
  const pose = await mp.PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: model('pose_landmarker_lite.task'), delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
  })
  await runtimeReady()
  const hand = await mp.HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: model('hand_landmarker.task'), delegate },
    runningMode: 'VIDEO',
    numHands: 2,
  })
  return {
    kind,
    delegate,
    see(frame, t) {
      const p = pose.detectForVideo(frame, t)
      const h = hand.detectForVideo(frame, t)
      const pic = p.landmarks[0]
      const seen: Seen = { body: bodyOf(p.worldLandmarks[0]), hands: [null, null], pics: [null, null], framed: framed(pic) }
      sidesOf(h, pic).forEach((side, k) => {
        if (seen.hands[side]) return
        seen.hands[side] = flat(h.worldLandmarks[k])
        seen.pics[side] = flat(h.landmarks[k], 2)
      })
      return seen
    },
    close: () => {
      pose.close()
      hand.close()
    },
  }
}
