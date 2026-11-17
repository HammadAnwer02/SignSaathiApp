// Owns the three.js scene: renderer, camera framing, the VRM avatar, and the frame loop
// that feeds Player poses into the avatar's normalized bones.

import {
  AmbientLight, Clock, Color, DirectionalLight, PerspectiveCamera, Quaternion, Scene, Vector3, WebGLRenderer,
  type Material, type Mesh,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { loadClip, loadIndex } from '../signs/data'
import { BONE_COUNT, CHEST, NECK, measureRest, type Rest } from './rig'
import { EXPRESSIONS, Solver, type Motion } from './solver'
import { Player } from './player'

export interface PlayRequest {
  id: string
  chip: number
  letter?: boolean
}

export type EngineState = 'loading' | 'ready' | 'error'

const SHIRT = new Color('#24345a')
const SHIRT_SHADE = new Color('#141d33')
/** height of the band the stage controls take at the top of the stage (.stage-controls: 12px inset + 44px buttons) */
const CONTROLS_PX = 60

export class AvatarEngine {
  private renderer: WebGLRenderer
  private scene = new Scene()
  private camera = new PerspectiveCamera(24, 1, 0.05, 20)
  private clock = new Clock()
  private vrm: VRM | null = null
  private rest: Rest | null = null
  private solver: Solver | null = null
  private player: Player | null = null
  private motions = new Map<string, Promise<Motion>>()
  private raf = 0
  private resizeObs: ResizeObserver
  private t = 0
  private nextBlink = 2
  private disposed = false
  private playToken = 0
  speed = 1
  onChip?: (chip: number) => void
  onPlaying?: (playing: boolean) => void

  constructor(private container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.domElement.setAttribute('aria-hidden', 'true')
    container.appendChild(this.renderer.domElement)

    const key = new DirectionalLight(0xffffff, 2.4)
    key.position.set(0.6, 1.6, 2.2)
    const fill = new DirectionalLight(0xfff1dc, 0.9)
    fill.position.set(-1.5, 1.2, 1)
    this.scene.add(key, fill, new AmbientLight(0xffffff, 0.75))

    this.resizeObs = new ResizeObserver(() => this.resize())
    this.resizeObs.observe(container)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.resize()
    this.loop()
  }

  async load(url: string) {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.loadAsync(url)
    if (this.disposed) return
    const vrm = gltf.userData.vrm as VRM
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    if (vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm)
    vrm.scene.traverse((o) => {
      o.frustumCulled = false
      // Interpreters wear plain dark tops so the hands read clearly; dye the avatar's top to match.
      const mesh = o as Mesh
      if (!mesh.isMesh) return
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (/tops/i.test(m.name)) {
          const mt = m as Material & { color?: Color; shadeColorFactor?: Color }
          mt.color?.set(SHIRT)
          mt.shadeColorFactor?.set(SHIRT_SHADE)
        }
      }
    })
    this.scene.add(vrm.scene)
    if (vrm.lookAt) vrm.lookAt.target = this.camera
    this.vrm = vrm
    this.rest = measureRest(vrm)
    this.solver = new Solver(this.rest)
    this.player = new Player(this.solver.idle)
    this.player.onChip = (c) => this.onChip?.(c)
    this.player.onEnd = () => this.onPlaying?.(false)
    this.applyPose(this.player.pose)
    this.resize()
  }

  get ready() {
    return !!this.player
  }

  /** Load + solve a sign's motion once; later calls reuse it. */
  motion(id: string): Promise<Motion> {
    let m = this.motions.get(id)
    if (!m) {
      m = Promise.all([loadIndex(), loadClip(id)]).then(([index, clip]) => {
        if (!this.solver) throw new Error('avatar not loaded')
        return this.solver.solveClip(clip, index.fps, index.face)
      })
      m.catch(() => this.motions.delete(id))
      this.motions.set(id, m)
    }
    return m
  }

  async play(requests: PlayRequest[]) {
    const token = ++this.playToken
    const motions = await Promise.all(requests.map((r) => this.motion(r.id)))
    if (token !== this.playToken || !this.player) return
    this.player.play(requests.map((r, i) => ({ motion: motions[i], chip: r.chip, letter: r.letter })))
    this.onPlaying?.(this.player.playing)
  }

  /** QA helper: hold one frame of a sign so it can be compared with the source video. */
  async debugPose(id: string, frame: number) {
    const m = await this.motion(id)
    this.playToken++
    this.player?.hold(m, frame)
  }

  stop() {
    this.playToken++
    this.player?.stop()
    this.onPlaying?.(false)
  }

  get playing() {
    return this.player?.playing ?? false
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resizeObs.disconnect()
    document.removeEventListener('visibilitychange', this.onVisibility)
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  // ------------------------------------------------------------------ internals

  /** Stop drawing while the app is in the background or the stage is collapsed (saves battery). */
  private hiddenStage = false
  private running = true
  private syncRunning() {
    const should = !document.hidden && !this.hiddenStage && !this.disposed
    if (should === this.running) return
    this.running = should
    if (should) {
      this.clock.getDelta()
      this.loop()
    } else cancelAnimationFrame(this.raf)
  }

  private onVisibility = () => this.syncRunning()

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(this.clock.getDelta(), 1 / 15)
    this.t += dt
    if (this.player && this.vrm) {
      this.player.update(dt * this.speed)
      this.applyPose(this.player.pose)
      this.breathe()
      this.applyExpressions(dt)
      this.vrm.update(dt)
    }
    this.renderer.render(this.scene, this.camera)
  }

  private applyPose(pose: Float32Array) {
    const nodes = this.rest!.nodes
    for (let b = 0; b < BONE_COUNT; b++) nodes[b]?.quaternion.fromArray(pose, b * 4)
  }

  private breatheQ = new Quaternion()
  private breatheAxis = new Vector3(1, 0, 0)
  private breathe() {
    const nodes = this.rest!.nodes
    const a = Math.sin(this.t * ((2 * Math.PI) / 4.2)) * 0.012
    this.breatheQ.setFromAxisAngle(this.breatheAxis, a)
    nodes[CHEST]?.quaternion.multiply(this.breatheQ)
    this.breatheQ.setFromAxisAngle(this.breatheAxis, -a * 0.6)
    nodes[NECK]?.quaternion.multiply(this.breatheQ)
  }

  private applyExpressions(dt: number) {
    const em = this.vrm!.expressionManager
    if (!em) return
    const ex = this.player!.expr
    // natural blinking while idle or when the clip has no blink data
    let idleBlink = 0
    this.nextBlink -= dt
    if (this.nextBlink < 0) {
      idleBlink = Math.max(0, 1 - Math.abs(this.nextBlink + 0.07) / 0.07)
      if (this.nextBlink < -0.14) this.nextBlink = 2.5 + Math.random() * 3
    }
    EXPRESSIONS.forEach((name, i) => {
      const v = name === 'blink' ? Math.max(ex[i], idleBlink) : ex[i]
      em.setValue(name, v)
    })
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    this.hiddenStage = this.container.clientHeight < 8
    this.syncRunning()
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    if (this.rest) {
      const r = this.rest
      // interpreter framing: top of the head to the waist, signing space either side of the body
      const top = r.headY + 0.2
      const bottom = r.hipsY + 0.1
      const width = r.shoulderWidth + 0.62
      const tan = Math.tan((this.camera.fov * Math.PI) / 360)
      // the speed and replay buttons cover the top of the stage: keep the hair below them,
      // sliding the avatar down when there is room and pulling back when there isn't
      const clear = Math.min(0.4, CONTROLS_PX / h)
      const span = Math.max(top - bottom, (r.topY - bottom) / (1 - clear))
      const dist = Math.max(span / (2 * tan), width / (2 * tan * this.camera.aspect))
      const view = 2 * dist * tan
      const cy = Math.max((top + bottom) / 2, r.topY - view / 2 + clear * view)
      this.camera.position.set(0, cy, dist)
      this.camera.lookAt(0, cy, 0)
    }
    this.camera.updateProjectionMatrix()
  }
}
