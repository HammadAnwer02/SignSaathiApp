// The page's side of the tracker: hands the worker one camera frame at a time and gets back what it saw.

import type { Delegate, Seen, TrackerKind } from './track'
import type { FromWorker, ToWorker } from './tracker.worker'

export interface Tracking {
  readonly kind: TrackerKind
  readonly delegate: Delegate
  /** follow the frame `source` shows now; `t` (ms) must go up from one call to the next */
  see(source: HTMLVideoElement | HTMLCanvasElement, t: number): Promise<Seen | null>
  /** how long the worker takes over a frame, ms (a running average) */
  readonly ms: number
  close(): void
}

/** a frame the worker hasn't answered in this long is given up on (the first ones are slow: shaders compile) */
const TIMEOUT_MS = 8000

export function startTracking(kind: TrackerKind = 'holistic', delegate: Delegate = 'GPU'): Promise<Tracking> {
  const worker = new Worker(new URL('./tracker.worker.ts', import.meta.url), { type: 'module' })
  const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer)
  const waiting = new Map<number, { ok: (s: Seen | null) => void; no: (e: Error) => void }>()
  let ms = 0
  let next = 0
  const tracking: Tracking = {
    kind,
    delegate,
    get ms() {
      return ms
    },
    async see(source, t) {
      const frame = await createImageBitmap(source)
      return new Promise((ok, no) => {
        const id = ++next
        waiting.set(id, { ok, no })
        send({ type: 'see', id, frame, t }, [frame])
        setTimeout(() => {
          if (!waiting.delete(id)) return
          no(new Error('the tracker stopped answering'))
        }, TIMEOUT_MS)
      })
    },
    close() {
      worker.terminate()
      for (const w of waiting.values()) w.no(new Error('tracker closed'))
      waiting.clear()
    },
  }
  return new Promise((ok, no) => {
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data
      if (m.type === 'ready') ok(tracking)
      else if (m.type === 'failed') {
        worker.terminate()
        no(new Error(m.error))
      } else {
        ms = ms ? ms + 0.1 * (m.ms - ms) : m.ms
        waiting.get(m.id)?.ok(m.seen)
        waiting.delete(m.id)
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      no(new Error(e.message || 'the tracker failed to start'))
    }
    send({ type: 'start', kind, delegate })
  })
}

let shared: Promise<Tracking> | null = null

/** The app's one tracker, started the first time it's asked for: on the GPU when it can, else the CPU. */
export function getTracking(): Promise<Tracking> {
  shared ??= startTracking('holistic', 'GPU').catch((err) => {
    console.warn('tracker: GPU failed, using the CPU', err)
    return startTracking('holistic', 'CPU')
  })
  shared.catch(() => (shared = null))
  return shared
}
