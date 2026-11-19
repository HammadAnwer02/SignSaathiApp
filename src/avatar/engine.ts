// Owns the three.js scene: renderer, camera framing, the VRM avatar, and the frame loop
// that feeds Player poses into the avatar's normalized bones.

import {
  AmbientLight, Clock, DirectionalLight, PerspectiveCamera, Quaternion, Scene, Vector3, WebGLRenderer,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { loadClip, loadIndex } from '../signs/data'
import { BONE_COUNT, CHEST, NECK, measureRest, toVrm0, type Rest } from './rig'
import { EXPRESSIONS, Solver, type Motion } from './solver'
import { Player } from './player'
import { applyLook } from './looks'

export interface PlayRequest {
  id: string
  chip: number
  letter?: boolean
}

export type EngineState = 'loading' | 'ready' | 'error'

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
  /** the play() whose sequence is running; a stop or a newer play() changes playToken and so voids it */
  private finishToken = -1
  private loadToken = 0
  speed = 1
  /** how far buttons over the top of the stage reach down, in px (the stage controls: 8px inset + 44px buttons);
   *  the framing keeps the head clear of them */
  private topClear = 60
  onChip?: (chip: number) => void
  onPlaying?: (playing: boolean) => void
  /** a sequence played through to its end (not stopped, not replaced by another) */
  onFinish?: () => void

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

  /** Load a signer, replacing the one on stage (if any). Resolves once the new signer is ready to play. */
  async load(url: string) {
    const token = ++this.loadToken
    this.unload()
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.loadAsync(url)
    const vrm = gltf.userData.vrm as VRM
    if (this.disposed || token !== this.loadToken) {
      // a newer signer was asked for while this one downloaded
      VRMUtils.deepDispose(gltf.scene)
      return
    }
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    if (vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm)
    vrm.scene.traverse((o) => {
      o.frustumCulled = false
    })
    applyLook(vrm)
    this.scene.add(vrm.scene)
    if (vrm.lookAt) vrm.lookAt.target = this.camera
    this.vrm = vrm
    this.rest = measureRest(vrm)
    this.solver = new Solver(this.rest)
    this.player = new Player(this.solver.idle)
    this.player.onChip = (c) => this.onChip?.(c)
    this.player.onEnd = () => {
      this.onPlaying?.(false)
      // a stop also ends with the glide back to rest; only a sequence that ran its course counts
      if (this.finishToken === this.playToken) this.onFinish?.()
    }
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
    this.finishToken = token
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
    this.unload()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }

  // ------------------------------------------------------------------ internals

  /** Take the current signer off stage; solved motions belong to its skeleton, so they go too. */
  private unload() {
    this.playToken++
    if (this.player?.playing) this.onPlaying?.(false)
    this.player = null
    this.solver = null
    this.rest = null
    this.motions.clear()
    if (this.vrm) {
      this.scene.remove(this.vrm.scene)
      VRMUtils.deepDispose(this.vrm.scene)
      this.vrm = null
    }
  }

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
    const { nodes, vrm0 } = this.rest!
    for (let b = 0; b < BONE_COUNT; b++) {
      const q = nodes[b]?.quaternion
      if (!q) continue
      q.fromArray(pose, b * 4)
      if (vrm0) toVrm0(q)
    }
  }

  private breatheQ = new Quaternion()
  private breatheAxis = new Vector3(1, 0, 0)
  private breathe() {
    const { nodes, vrm0 } = this.rest!
    // a pitch about x: the same angle tips the other way on a model that faces the other way
    const a = Math.sin(this.t * ((2 * Math.PI) / 4.2)) * 0.012 * (vrm0 ? -1 : 1)
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

  setTopClear(px: number) {
    if (px === this.topClear) return
    this.topClear = px
    this.resize()
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
      const clear = Math.min(0.4, this.topClear / h)
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
