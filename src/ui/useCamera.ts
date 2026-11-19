// The front camera for practising along, and keeping the screen awake while you do.

import { useCallback, useEffect, useState, type RefObject } from 'react'

export type CameraState = 'starting' | 'live' | 'blocked' | 'missing' | 'failed'

/**
 * Shows the front camera in `video` for as long as the calling component is mounted. Nothing is
 * recorded: the stream only feeds the element. The camera is let go whenever the app is in the
 * background, so the camera light goes off, and picked up again on return.
 */
export function useCamera(video: RefObject<HTMLVideoElement | null>) {
  const [state, setState] = useState<CameraState>('starting')
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    let stream: MediaStream | null = null
    let alive = true
    let starting = false

    const release = () => {
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      if (video.current) video.current.srcObject = null
    }

    const start = async () => {
      if (starting || stream || document.hidden) return
      starting = true
      setState('starting')
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('No camera API', 'NotFoundError')
        const s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
        })
        if (!alive || document.hidden) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        // a phone call or another app can take the camera; say so rather than show a frozen frame
        s.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (stream !== s) return
          release()
          if (alive && !document.hidden) setState('failed')
        })
        const v = video.current
        if (v) {
          v.srcObject = s
          await v.play().catch(() => {})
        }
        setState('live')
      } catch (err) {
        if (!alive) return
        const name = err instanceof DOMException ? err.name : ''
        setState(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'blocked'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'missing'
              : 'failed',
        )
      } finally {
        starting = false
      }
    }

    const onVisibility = () => {
      if (document.hidden) release()
      else void start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    void start()
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisibility)
      release()
    }
  }, [video, attempt])

  return { state, retry }
}

/** Keep the screen on while mounted: someone signing along has their hands busy and never touches it. */
export function useWakeLock() {
  useEffect(() => {
    if (!('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let alive = true
    const take = () => {
      if (document.hidden || lock) return
      navigator.wakeLock.request('screen').then(
        (l) => {
          if (!alive) {
            void l.release()
            return
          }
          lock = l
          // the system drops the lock whenever the app goes to the background
          l.addEventListener('release', () => {
            if (lock === l) lock = null
          })
        },
        () => {},
      )
    }
    document.addEventListener('visibilitychange', take)
    take()
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', take)
      void lock?.release().catch(() => {})
    }
  }, [])
}
