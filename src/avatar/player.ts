// Sequences solved sign motions into one continuous performance: eased blends between
// signs, shorter blends between fingerspelled letters, and a return to idle at the end.

import { Quaternion } from 'three'
import { BONE_COUNT } from './rig'
import { EXPR_COUNT, type Motion } from './solver'

export interface PlayItem {
  motion: Motion
  /** index of the caption chip this belongs to (for highlighting) */
  chip: number
  /** fingerspelled letter: play only the held handshape and blend quickly */
  letter?: boolean
}

interface Segment {
  start: number
  dur: number
  chip: number
  // clip segment
  motion?: Motion
  f0?: number
  f1?: number
  // blend segment
  from?: Float32Array
  fromExpr?: Float32Array
  to?: Float32Array
  toExpr?: Float32Array
}

const POSE = BONE_COUNT * 4
export const TIMING = { in: 0.35, between: 0.2, letter: 0.13, out: 0.55 }

const smooth = (t: number) => t * t * (3 - 2 * t)
// three's typings declare slerpFlat over number[]; typed arrays work the same at runtime
const flat = (a: Float32Array) => a as unknown as number[]

export class Player {
  readonly pose = new Float32Array(POSE)
  readonly expr = new Float32Array(EXPR_COUNT)
  private idlePose = new Float32Array(POSE)
  private idleExpr = new Float32Array(EXPR_COUNT)
  private segments: Segment[] = []
  private time = 0
  private total = 0
  chip = -1
  playing = false
  onChip?: (chip: number) => void
  onEnd?: () => void

  constructor(idle: Quaternion[]) {
    idle.forEach((q, b) => q.toArray(this.idlePose, b * 4))
    this.pose.set(this.idlePose)
  }

  /** Start a new performance from whatever pose is showing now. */
  play(items: PlayItem[]) {
    const segs: Segment[] = []
    let t = 0
    let prevPose: Float32Array = this.pose.slice()
    let prevExpr: Float32Array = this.expr.slice()
    items.forEach((it, i) => {
      const m = it.motion
      let f0 = 0
      let f1 = m.frames - 1
      if (it.letter) [f0, f1] = letterRange(m)
      else {
        // between signs the hands stay up in signing space: skip the clip's own rise from rest
        // (unless it opens the sentence) and its drop back to rest (unless it closes it)
        const margin = 2
        if (i > 0) f0 = Math.max(0, m.core[0] - margin)
        if (i < items.length - 1) f1 = Math.min(m.frames - 1, m.core[1] + margin)
        if (f1 <= f0) [f0, f1] = [0, m.frames - 1]
      }
      const blendDur = i === 0 ? TIMING.in : it.letter && items[i - 1].letter ? TIMING.letter : TIMING.between
      const firstPose = m.q.subarray(f0 * POSE, (f0 + 1) * POSE)
      const firstExpr = m.expr.subarray(f0 * EXPR_COUNT, (f0 + 1) * EXPR_COUNT)
      segs.push({ start: t, dur: blendDur, chip: it.chip, from: prevPose, fromExpr: prevExpr, to: firstPose, toExpr: firstExpr })
      t += blendDur
      const dur = Math.max(1, f1 - f0) / m.fps
      segs.push({ start: t, dur, chip: it.chip, motion: m, f0, f1 })
      t += dur
      prevPose = m.q.subarray(f1 * POSE, (f1 + 1) * POSE)
      prevExpr = m.expr.subarray(f1 * EXPR_COUNT, (f1 + 1) * EXPR_COUNT)
    })
    segs.push({ start: t, dur: TIMING.out, chip: -1, from: prevPose, fromExpr: prevExpr, to: this.idlePose, toExpr: this.idleExpr })
    t += TIMING.out
    this.segments = segs
    this.total = t
    this.time = 0
    this.playing = items.length > 0
    this.setChip(this.playing ? items[0].chip : -1)
  }

  stop() {
    if (!this.playing) return
    // glide back to idle from the current pose
    this.segments = [{ start: 0, dur: TIMING.out, chip: -1, from: this.pose.slice(), fromExpr: this.expr.slice(), to: this.idlePose, toExpr: this.idleExpr }]
    this.total = TIMING.out
    this.time = 0
    this.setChip(-1)
  }

  /** Freeze on one frame of a motion (used for QA against the source video). */
  hold(m: Motion, frame: number) {
    const i = Math.max(0, Math.min(m.frames - 1, Math.round(frame)))
    this.segments = []
    this.playing = false
    this.pose.set(m.q.subarray(i * POSE, (i + 1) * POSE))
    this.expr.set(m.expr.subarray(i * EXPR_COUNT, (i + 1) * EXPR_COUNT))
  }

  get progress() {
    return this.total ? Math.min(1, this.time / this.total) : 0
  }

  update(dt: number) {
    if (!this.segments.length) return
    this.time += dt
    if (this.time >= this.total) {
      this.pose.set(this.idlePose)
      this.expr.set(this.idleExpr)
      this.segments = []
      const wasPlaying = this.playing
      this.playing = false
      this.setChip(-1)
      if (wasPlaying) this.onEnd?.()
      return
    }
    const seg = this.segments.find((s) => this.time < s.start + s.dur) ?? this.segments[this.segments.length - 1]
    const u = Math.min(1, Math.max(0, (this.time - seg.start) / seg.dur))
    if (seg.motion) {
      const m = seg.motion
      const pos = seg.f0! + u * (seg.f1! - seg.f0!)
      const i = Math.min(m.frames - 1, Math.floor(pos))
      const j = Math.min(m.frames - 1, i + 1)
      const k = pos - i
      for (let b = 0; b < BONE_COUNT; b++) {
        Quaternion.slerpFlat(flat(this.pose), b * 4, flat(m.q), (i * BONE_COUNT + b) * 4, flat(m.q), (j * BONE_COUNT + b) * 4, k)
      }
      for (let e = 0; e < EXPR_COUNT; e++) {
        this.expr[e] = m.expr[i * EXPR_COUNT + e] * (1 - k) + m.expr[j * EXPR_COUNT + e] * k
      }
    } else {
      const k = smooth(u)
      for (let b = 0; b < BONE_COUNT; b++) Quaternion.slerpFlat(flat(this.pose), b * 4, flat(seg.from!), b * 4, flat(seg.to!), b * 4, k)
      for (let e = 0; e < EXPR_COUNT; e++) this.expr[e] = seg.fromExpr![e] * (1 - k) + seg.toExpr![e] * k
    }
    this.setChip(seg.chip)
  }

  private setChip(c: number) {
    if (c !== this.chip) {
      this.chip = c
      this.onChip?.(c)
    }
  }
}

/** Frames where the hand is fully up, trimmed to at most ~0.6 s around the middle. */
function letterRange(m: Motion): [number, number] {
  let a = 0
  let b = m.frames - 1
  if (m.core) [a, b] = m.core
  const maxFrames = Math.round(0.6 * m.fps)
  if (b - a > maxFrames) {
    const mid = (a + b) / 2
    a = Math.round(mid - maxFrames / 2)
    b = a + maxFrames
  }
  return [a, b]
}
