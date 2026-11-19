// Watches your signing through the camera and says when it matches the sign you're learning. Everything happens on
// the device: frames go to the tracker and are dropped, only a few seconds of hand positions are kept.

import { useEffect, useRef, useState, type RefObject } from 'react'
import { loadClip, loadIndex } from '../signs/data'
import { Attempt, closeness, compare, MARGIN, PASS, rivalCost, signFeats, type Feat, type Series, type Verdict } from './match'
import type { Seen } from './track'
import { getTracking } from './tracking'

export type CheckState = 'off' | 'loading' | 'watching' | 'matched' | 'unavailable'

export interface SignCheck {
  state: CheckState
  /** how close the attempts in the last few seconds came, from 0 to 1 */
  close: number
  /** the camera can't see both shoulders, so where the hands are can't be judged */
  unframed: boolean
}

const feats = new Map<string, Promise<Feat[]>>()

/** a sign's recording, described for comparing (once per sign) */
function featsOf(id: string): Promise<Feat[]> {
  let f = feats.get(id)
  if (!f) {
    f = Promise.all([loadIndex(), loadClip(id)]).then(([index, clip]) => signFeats(clip, index.fps))
    f.catch(() => feats.delete(id))
    feats.set(id, f)
  }
  return f
}

/** follow the camera this often at most, ms: leaves the phone time to draw the signer */
const SEE_MS = 66
/** compare this often, ms */
const CHECK_MS = 400
/** ask to move back once the shoulders have been out of the picture this long, ms */
const UNFRAMED_MS = 1200

// the hand's bones, as pairs of MediaPipe hand points
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
]

/** Draw the hands the tracker found over the camera picture, so you can see it following you. */
function draw(canvas: HTMLCanvasElement | null, video: HTMLVideoElement, seen: Seen | null) {
  if (!canvas) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const W = canvas.clientWidth
  const H = canvas.clientHeight
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
  }
  const g = canvas.getContext('2d')
  if (!g) return
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, W, H)
  if (!seen) return
  // the picture fills the tile like the video does (object-fit: cover, object-position: 50% 30%)
  const vw = video.videoWidth
  const vh = video.videoHeight
  const s = Math.max(W / vw, H / vh)
  const ox = (W - vw * s) * 0.5
  const oy = (H - vh * s) * 0.3
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const pic of seen.pics) {
    if (!pic) continue
    const at = (k: number): [number, number] => [ox + pic[k * 2] * vw * s, oy + pic[k * 2 + 1] * vh * s]
    g.strokeStyle = 'rgb(255 255 255 / 0.9)'
    g.lineWidth = 3
    g.shadowColor = 'rgb(0 0 0 / 0.45)'
    g.shadowBlur = 4
    g.beginPath()
    for (const [a, b] of BONES) {
      g.moveTo(...at(a))
      g.lineTo(...at(b))
    }
    g.stroke()
    g.shadowBlur = 0
    g.fillStyle = '#5fd4e8'
    for (let k = 0; k < 21; k++) {
      const [x, y] = at(k)
      g.beginPath()
      g.arc(x, y, 3.2, 0, Math.PI * 2)
      g.fill()
    }
  }
}

/**
 * While `sign` is set (and the camera is live), follow the hands in `video`, draw them on `overlay`, and call `onMatch`
 * once the signing matches it better than any of `rivals` (the other signs it could be mistaken for). `round` starts
 * the watching afresh, as when the same sign is asked for again.
 */
export function useSignCheck(
  video: RefObject<HTMLVideoElement | null>,
  overlay: RefObject<HTMLCanvasElement | null>,
  sign: string | null,
  rivals: readonly string[],
  round: number,
  onMatch: () => void,
): SignCheck {
  const [state, setState] = useState<CheckState>('off')
  const [close, setClose] = useState(0)
  const [unframed, setUnframed] = useState(false)
  const matched = useRef(onMatch)
  useEffect(() => {
    matched.current = onMatch
  }, [onMatch])

  useEffect(() => {
    setClose(0)
    setUnframed(false)
    if (!sign) {
      setState('off')
      return
    }
    let alive = true
    let raf = 0
    setState('loading')
    const others = Promise.all(rivals.filter((id) => id !== sign).map((id) => featsOf(id).catch(() => [])))
    Promise.all([getTracking(), featsOf(sign), others]).then(
      ([tracking, target, others]) => {
        if (!alive) return
        const rivalFeats = others.filter((f) => f.length)
        const attempt = new Attempt()
        let lastSee = 0
        /** a frame is with the tracker: the next goes once it's answered */
        let busy = false
        let lastCheck = 0
        let framedAt = performance.now()
        let wasUnframed = false
        /** the sign matched: are any of the others closer? Worked through a few at a time, between frames */
        let scan: { v: Verdict; series: Series; next: number; best: number } | null = null
        const pass = () => {
          alive = false
          cancelAnimationFrame(raf)
          setState('matched')
          matched.current()
        }
        setState('watching')
        const tick = (now: number) => {
          if (!alive) return
          raf = requestAnimationFrame(tick)
          const v = video.current
          if (v && v.readyState >= 2 && v.videoWidth && !busy && now - lastSee >= SEE_MS) {
            lastSee = now
            busy = true
            tracking.see(v, now).then(
              (seen) => {
                busy = false
                if (!alive) return
                attempt.add(now, seen?.body ?? null, seen?.hands ?? [null, null])
                draw(overlay.current, v, seen)
                if (seen?.framed) framedAt = now
                const out = now - framedAt > UNFRAMED_MS
                if (out !== wasUnframed) {
                  wasUnframed = out
                  setUnframed(out)
                }
              },
              (err) => {
                console.warn('sign check: tracking failed', err)
                alive = false
                cancelAnimationFrame(raf)
                setState('unavailable')
              },
            )
          }
          if (scan) {
            const until = performance.now() + 6
            while (scan.next < rivalFeats.length && scan.best >= scan.v.cost - MARGIN && performance.now() < until)
              scan.best = Math.min(scan.best, rivalCost(rivalFeats[scan.next++], scan.series, scan.v))
            if (import.meta.env.DEV) Object.assign((window as unknown as { __check: object }).__check, { rival: scan.best })
            // another sign fits this signing clearly better: keep watching
            if (scan.best < scan.v.cost - MARGIN) scan = null
            else if (scan.next >= rivalFeats.length) pass()
            return
          }
          if (now - lastCheck < CHECK_MS) return
          lastCheck = now
          const series = attempt.series()
          const verdict = compare(target, series)
          setClose(closeness(verdict.cost))
          if (import.meta.env.DEV) (window as unknown as { __check?: object }).__check = { ...verdict, ms: tracking.ms }
          if (verdict.cost <= PASS) scan = { v: verdict, series, next: 0, best: Infinity }
        }
        raf = requestAnimationFrame(tick)
      },
      (err) => {
        console.warn('sign check unavailable', err)
        if (alive) setState('unavailable')
      },
    )
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      const c = overlay.current
      c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    }
  }, [sign, rivals, round, video, overlay])

  return { state, close, unframed }
}
