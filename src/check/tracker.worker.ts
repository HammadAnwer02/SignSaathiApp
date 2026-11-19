// Runs the tracker away from the page, so following the camera never holds up the signer's animation.

import { createTracker, type Delegate, type Seen, type Tracker, type TrackerKind } from './track'

export type ToWorker =
  | { type: 'start'; kind: TrackerKind; delegate: Delegate }
  | { type: 'see'; id: number; frame: ImageBitmap; t: number }

export type FromWorker =
  | { type: 'ready' }
  | { type: 'failed'; error: string }
  | { type: 'seen'; id: number; seen: Seen | null; ms: number }

let tracker: Tracker | null = null
const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, { transfer })

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data
  if (m.type === 'start') {
    try {
      tracker = await createTracker(m.kind, m.delegate)
      post({ type: 'ready' })
    } catch (err) {
      post({ type: 'failed', error: String(err) })
    }
    return
  }
  const t0 = performance.now()
  let seen: Seen | null = null
  try {
    seen = tracker?.see(m.frame, m.t) ?? null
  } catch (err) {
    console.warn('tracker: a frame failed', err)
  } finally {
    m.frame.close()
  }
  const arrays = seen ? [seen.body, ...seen.hands, ...seen.pics].filter((a) => a !== null) : []
  post({ type: 'seen', id: m.id, seen, ms: performance.now() - t0 }, arrays.map((a) => a.buffer))
}
