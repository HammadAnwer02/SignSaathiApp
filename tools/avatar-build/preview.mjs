// usage: node preview.mjs <vrm|app> <outPrefix> [--signer=male|female] [--env=<intensity>] [--text=...] [--faces=0]
//
// Loads a VRM from disk into the running dev app on port 5190 (no project files touched), or with "app" keeps the
// app's own signer, and captures: the Translate screen idle and mid-sentence, and head close-ups in each expression.
// --env lights PBR materials with three's RoomEnvironment (through PMREM) at that intensity, as engine.ts could;
// MToon materials ignore it.
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const opt = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.slice(2).split('=')
    return [k, v.join('=')]
  }),
)
const [vrm, out] = args.filter((a) => !a.startsWith('--'))
const text = opt.text ?? 'hello how are you'
const signer = opt.signer ?? 'male'
const env = Number(opt.env ?? 0)

const b = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2 })
const logs = []
p.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
p.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`)
})
if (vrm !== 'app') await p.route('**/__preview/signer.vrm', (r) => r.fulfill({ path: vrm, contentType: 'model/gltf-binary' }))
await p.addInitScript((signer) => {
  localStorage.setItem('CapacitorStorage.welcomed', '1')
  localStorage.setItem('CapacitorStorage.signer', signer)
}, signer)
await p.goto('http://localhost:5190/', { waitUntil: 'load' })
await p.addStyleTag({ content: '.app{padding-top:59px!important}' })
await p.waitForFunction(() => window.__engine?.ready, null, { timeout: 120000 })
if (vrm !== 'app') {
  await p.evaluate(async () => {
    await window.__engine.load('/__preview/signer.vrm')
  })
  await p.waitForFunction(() => window.__engine?.ready, null, { timeout: 120000 })
}
await p.evaluate(async (intensity) => {
  const e = window.__engine
  if (intensity > 0) {
    // the same three instance the app runs on: Vite serves RoomEnvironment importing its pre-bundled copy
    const path = '/node_modules/three/examples/jsm/environments/RoomEnvironment.js'
    const src = await (await fetch(path)).text()
    const THREE = await import(src.match(/from "([^"]*\.vite\/deps\/three\.js[^"]*)"/)[1])
    const { RoomEnvironment } = await import(path)
    const pmrem = new THREE.PMREMGenerator(e.renderer)
    e.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    e.scene.environmentIntensity = intensity
    pmrem.dispose()
  }
}, env)
await p.waitForTimeout(800)
const info = await p.evaluate(() => {
  const e = window.__engine
  const names = []
  e.vrm.scene.traverse((o) => {
    if (o.isMesh) names.push(`${o.name}:${[].concat(o.material).map((m) => m.type).join('/')}`)
  })
  return {
    meta: e.vrm.meta.name ?? e.vrm.meta.title,
    version: e.vrm.meta.metaVersion,
    expressions: e.vrm.expressionManager?.expressions.map((x) => x.expressionName),
    environment: !!e.scene.environment,
    meshes: names,
  }
})
console.log(JSON.stringify(info))
const STAGE = { x: 0, y: 0, width: 402, height: 560 }
await p.screenshot({ path: `${out}-idle.png`, clip: STAGE })
await p.fill('textarea', text)
await p.press('textarea', 'Enter')
for (const [i, t] of [1200, 900, 900].entries()) {
  await p.waitForTimeout(t)
  await p.screenshot({ path: `${out}-sign${i}.png`, clip: STAGE })
}
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${out}-idle.png`, '-i', `${out}-sign0.png`, '-i', `${out}-sign1.png`, '-i', `${out}-sign2.png`, '-filter_complex', 'hstack=inputs=4,scale=iw/2:-1', `${out}-app.png`])

if (opt.faces !== '0') {
  // head close-ups, one per expression, holding the face still, with the stage's buttons out of the way
  await p.evaluate(() => window.__engine.stop())
  await p.addStyleTag({ content: '.stage-controls,.signer,.caption,.practise{visibility:hidden!important}' })
  await p.waitForTimeout(1200)
  const canvas = await p.$('canvas')
  const box = await canvas.boundingBox()
  const w = box.width * 0.62
  const h = Math.min(box.height * 0.8, w * 1.15)
  const clip = { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h }
  const shots = []
  for (const ex of ['', 'blink=1', 'aa=1', 'ou=1', 'happy=1', 'surprised=1', 'angry=1', 'sad=1']) {
    await p.evaluate((ex) => {
      const e = window.__engine
      e.player.expr.fill(0)
      const names = ['blink', 'aa', 'ou', 'happy', 'surprised', 'angry', 'sad']
      if (ex) {
        const [k, w] = ex.split('=')
        e.player.expr[names.indexOf(k)] = Number(w)
      }
      e.nextBlink = 1e9
      const V = e.camera.position.constructor
      const eye = e.vrm.humanoid.getNormalizedBoneNode('leftEye')
      const head = e.vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new V())
      // aim between the eyes and the mouth, a little to the signer's left
      const eyes = eye ? eye.getWorldPosition(new V()).y : head.y + 0.07
      const cam = e.camera
      const cy = eyes - 0.025
      const dist = 0.95
      cam.position.set(Math.sin(0.35) * dist, cy, Math.cos(0.35) * dist)
      cam.lookAt(0, cy, 0)
      cam.updateProjectionMatrix()
    }, ex)
    await p.waitForTimeout(350)
    const path = `${out}-face-${shots.length}.png`
    await p.screenshot({ path, clip })
    shots.push(path)
  }
  const row = (s) => ['-filter_complex', `hstack=inputs=${s.length},scale=iw/2:-1`]
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...shots.slice(0, 4).flatMap((s) => ['-i', s]), ...row(shots.slice(0, 4)), `${out}-faces-a.png`])
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...shots.slice(4).flatMap((s) => ['-i', s]), ...row(shots.slice(4)), `${out}-faces-b.png`])
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${out}-faces-a.png`, '-i', `${out}-faces-b.png`, '-filter_complex', 'vstack=inputs=2', `${out}-faces.png`])
}
console.log(logs.join('\n') || 'no errors')
// browser.close() has hung before; the screenshots are on disk by now
process.exit(0)
