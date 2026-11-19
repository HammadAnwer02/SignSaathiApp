// How fast the sign check's trackers run on this device. Only in a build made with VITE_BENCH=1: it tracks the front
// camera with each tracker for ten seconds, then a dictionary video on a loop, and logs the timings (on iOS, read them
// with `xcrun devicectl device process launch --console`). Before building, copy a dictionary video to
// public/bench/good.mp4, and for the lighter tracker pose_landmarker_lite.task and hand_landmarker.task to
// public/models/ (pipeline/fetch.py and its .cache); take them out again afterwards, as the app doesn't ship them.

import type { Delegate, TrackerKind } from './track'
import { startTracking } from './tracking'

const log = (msg: string) => console.log(`[bench] ${msg}`)
const nextFrame = () => new Promise<number>((ok) => requestAnimationFrame(ok))

/** frame times on the main thread while `run` goes: what the signer's animation is left with */
async function framesDuring(run: () => Promise<void>) {
  const gaps: number[] = []
  let last = performance.now()
  let on = true
  const tick = (now: number) => {
    gaps.push(now - last)
    last = now
    if (on) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  await run()
  on = false
  gaps.sort((a, b) => a - b)
  return { fps: 1000 / (gaps.reduce((s, g) => s + g, 0) / gaps.length), p95: gaps[Math.floor(gaps.length * 0.95)] }
}

async function camera(kind: TrackerKind, delegate: Delegate, cam: HTMLVideoElement) {
  const t0 = performance.now()
  const tracking = await startTracking(kind, delegate)
  log(`${cam.srcObject ? 'camera' : 'video'} ${kind} ${delegate}: started in ${(performance.now() - t0).toFixed(0)} ms`)
  const trips: number[] = []
  let hands = 0
  let busy = false
  const frames = await framesDuring(async () => {
    const end = performance.now() + 10_000
    let last = 0
    while (performance.now() < end) {
      const now = await nextFrame()
      if (busy || now - last < 66) continue
      last = now
      busy = true
      const a = performance.now()
      tracking.see(cam, now).then(
        (seen) => {
          busy = false
          trips.push(performance.now() - a)
          if (seen?.hands[0] || seen?.hands[1]) hands++
          if (trips.length <= 2) log(`  frame ${trips.length}: ${trips[trips.length - 1].toFixed(0)} ms`)
        },
        (err) => {
          busy = false
          log(`  frame failed: ${err}`)
        },
      )
    }
  })
  await new Promise((ok) => setTimeout(ok, 300))
  const warm = trips.slice(3).sort((a, b) => a - b)
  log(
    `${cam.srcObject ? 'camera' : 'video'} ${cam.videoWidth}x${cam.videoHeight} ${kind} ${delegate}: worker ${tracking.ms.toFixed(1)} ms a frame, round trip ` +
      `median ${warm[warm.length >> 1]?.toFixed(0)} ms (slowest ${warm[warm.length - 1]?.toFixed(0)}), ` +
      `${(trips.length / 10).toFixed(1)} tracked a second, hands in ${hands}; screen ${frames.fps.toFixed(0)} fps, ` +
      `95% of frames within ${frames.p95.toFixed(0)} ms`,
  )
  tracking.close()
}

export async function runBench() {
  await new Promise((ok) => setTimeout(ok, 4000)) // let the app and its signer settle first
  log(`start: ${navigator.userAgent}`)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
    })
    const cam = document.createElement('video')
    cam.muted = true
    cam.playsInline = true
    cam.srcObject = stream
    await cam.play()
    log(`camera on: ${cam.videoWidth}x${cam.videoHeight}`)
    const grabs: number[] = []
    for (let i = 0; i < 20; i++) {
      await nextFrame()
      const a = performance.now()
      ;(await createImageBitmap(cam)).close()
      grabs.push(performance.now() - a)
    }
    grabs.sort((a, b) => a - b)
    log(`taking a camera frame: median ${grabs[10].toFixed(1)} ms, slowest ${grabs[19].toFixed(1)} ms`)
    for (const [kind, delegate] of [['holistic', 'GPU'], ['lite', 'GPU']] as const) {
      try {
        await camera(kind, delegate, cam)
      } catch (err) {
        log(`camera ${kind} ${delegate}: failed: ${err}`)
      }
    }
    stream.getTracks().forEach((t) => t.stop())
  } catch (err) {
    log(`camera: ${err}`)
  }

  // someone signing: a dictionary video on a loop, tracked like the camera
  try {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.loop = true
    v.src = `${import.meta.env.BASE_URL}bench/good.mp4`
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none'
    document.body.append(v)
    await v.play()
    for (const [kind, delegate] of [['holistic', 'GPU'], ['lite', 'GPU']] as const) await camera(kind, delegate, v)
    v.remove()
  } catch (err) {
    log(`video: ${err}`)
  }
  log('done')
}
