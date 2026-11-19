// One lesson or review, a step at a time: the signer shows the question, you answer underneath.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSignCheck } from '../check/useSignCheck'
import { letterId, type Item } from '../learn/course'
import { stepItem, type Step } from '../learn/lesson'
import type { GlossItem } from '../text/translate'
import { CameraOffIcon, CheckIcon, ClearIcon } from './icons'
import { PracticeView } from './Practice'
import type { CameraState } from './useCamera'
import { buzz, tap } from '../native'

const noop = () => {}

export interface LessonResult {
  /** each sign asked about, and whether every answer about it was right */
  results: Map<string, boolean>
  answered: number
  mistakes: number
}

/** a sign, or a single letter (letters play with the short hold the translator uses) */
export const glossOf = (item: Item): GlossItem =>
  item.letter
    ? { kind: 'spell', text: item.en, letters: [{ id: item.id, char: item.en.toLowerCase() }] }
    : { kind: 'sign', text: item.en, seq: [item.id], alts: [] }

const glossOfWord = (word: string): GlossItem =>
  ({ kind: 'spell', text: word, letters: [...word].map((c) => ({ id: letterId(c), char: c })) })

function shuffle<T>(list: T[]): T[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** the same question with its answers in a new order, for asking again later */
function again(s: Step): Step {
  if (s.type === 'choose') return { ...s, options: shuffle(s.options) }
  if (s.type === 'spell') return { ...s, options: shuffle(s.options) }
  if (s.type === 'pick') return { ...s, order: shuffle(s.order) as [string, string] }
  return s
}

/** the answers on offer, and which one is right */
function answersOf(s: Step): { keys: string[]; right: number } {
  if (s.type === 'choose') return { keys: s.options, right: s.options.indexOf(s.item) }
  if (s.type === 'pick') return { keys: s.order, right: s.order.indexOf(s.item) }
  if (s.type === 'spell') return { keys: s.options, right: s.options.indexOf(s.word) }
  return { keys: [], right: -1 }
}

interface Entry {
  step: Step
  /** how many times it has been asked again after a wrong answer */
  tries: number
}

interface Props {
  steps: Step[]
  items: Map<string, Item>
  onPlay: (items: GlossItem[], captions?: string[]) => void
  onDone: (r: LessonResult) => void
  onQuit: () => void
  /** where the close button and progress bar go, above the signer */
  top: HTMLElement | null
  /** signing along: the signer repeats the sign until the step is over */
  onSignAlong: (on: boolean) => void
  /** the signer is shown mirrored while you sign along (practice's Mirror setting) */
  mirror: boolean
  /** show your camera while you sign along */
  camera: boolean
  onCamera: (on: boolean) => void
}

export function Lesson(props: Props) {
  const { steps, items, onPlay, onDone, onQuit, top, onSignAlong, mirror, camera, onCamera } = props
  const [queue, setQueue] = useState<Entry[]>(() => steps.map((step) => ({ step, tries: 0 })))
  const [pos, setPos] = useState(0)
  const [chosen, setChosen] = useState<number | null>(null)
  const foot = useRef<HTMLElement>(null)
  const results = useRef(new Map<string, boolean>())
  const tally = useRef({ answered: 0, mistakes: 0 })
  const entry = queue[pos]
  const step = entry.step
  const item = step.type === 'spell' ? undefined : items.get(step.item)
  const { keys, right } = answersOf(step)
  const answered = chosen !== null
  const correct = chosen === right

  // the sign-it step: your camera, and the check that watches it
  const video = useRef<HTMLVideoElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const [cam, setCam] = useState<CameraState>('starting')
  /** the check saw you sign it */
  const [signed, setSigned] = useState(false)
  const onMatch = useCallback(() => {
    buzz(true)
    setSigned(true)
  }, [])
  // the course's other signs: a match only counts if none of them fits the signing better
  const rivals = useMemo(() => [...items.keys()], [items])
  const check = useSignCheck(video, overlay, step.type === 'sign' && camera && cam === 'live' ? step.item : null, rivals, pos, onMatch)

  if (import.meta.env.DEV) (window as unknown as { __learnStep?: Step }).__learnStep = step

  // each question plays as it opens; the stage's replay button plays it again
  useEffect(() => {
    if (step.type === 'pick') onPlay(step.order.map((id) => glossOf(items.get(id)!)), ['1', '2'])
    else if (step.type === 'spell') onPlay([glossOfWord(step.word)])
    else onPlay([glossOf(items.get(step.item)!)])
  }, [step, items, onPlay])

  useEffect(() => {
    onSignAlong(step.type === 'sign')
  }, [step, onSignAlong])

  // each step starts at its top, whatever the last one was scrolled to
  useEffect(() => {
    foot.current?.closest('.pane')?.scrollTo({ top: 0 })
  }, [pos])
  useEffect(() => () => onSignAlong(false), [onSignAlong])

  // on a short screen the verdict could cover the last answers: bring them all into view above it
  useEffect(() => {
    if (!answered && !signed) return
    const pane = foot.current?.closest('.pane')
    pane?.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' })
  }, [answered, signed])

  const respond = (i: number) => {
    if (answered) return
    const ok = i === right
    setChosen(i)
    buzz(ok)
    tally.current.answered++
    const id = stepItem(step)
    if (id) results.current.set(id, (results.current.get(id) ?? true) && ok)
    if (!ok) {
      tally.current.mistakes++
      // ask it again at the end, twice at most
      if (entry.tries < 2) setQueue((q) => [...q, { step: again(step), tries: entry.tries + 1 }])
    }
  }

  /** on to the next step; `added` counts a step just put back on the queue */
  const advance = (added = 0) => {
    if (pos + 1 >= queue.length + added) onDone({ results: results.current, ...tally.current })
    else {
      setPos(pos + 1)
      setChosen(null)
      setSigned(false)
    }
  }

  const next = () => {
    tap()
    advance()
  }

  // your own verdict on signing it: "not yet" brings the sign back sooner in reviews (and once more before the
  // end of this lesson), but costs no XP, so there's nothing to gain by being generous with yourself
  const rate = (ok: boolean) => {
    tap()
    if (ok) {
      advance()
      return
    }
    const id = stepItem(step)
    if (id) results.current.set(id, false)
    const again = entry.tries < 1
    if (again) setQueue((q) => [...q, { step, tries: entry.tries + 1 }])
    advance(again ? 1 : 0)
  }

  const quit = () => {
    if (pos > 0 && !window.confirm('End this lesson? You’ll start it from the beginning next time.')) return
    onQuit()
  }

  const done = pos + (answered || signed || step.type === 'teach' ? 1 : 0)
  const label = (key: string) => (step.type === 'spell' ? key.toUpperCase() : items.get(key)?.en ?? key)

  const bar = (
    <div className="lesson-bar">
      <button className="lesson-close" onClick={quit} aria-label="End the lesson">
        <ClearIcon size={22} />
      </button>
      <div className="lesson-progress" role="progressbar" aria-label="Lesson progress" aria-valuemin={0}
        aria-valuemax={queue.length} aria-valuenow={done}>
        <span style={{ width: `${(done / queue.length) * 100}%` }} />
      </div>
    </div>
  )

  return (
    <div className="lesson">
      {top && createPortal(bar, top)}

      <div className={`lesson-body ${step.type === 'sign' ? 'signing' : ''}`}>
        {step.type === 'sign' && item && (
          <>
            <p className="lesson-ask">
              Your turn: sign <b>{item.letter ? `the letter ${item.en}` : item.en}</b>
              {item.ur && <span className="ur" lang="ur">{item.ur}</span>}
            </p>
            {queue.findIndex((e) => e.step.type === 'sign') === pos && (
              <p className="lesson-tip">
                {mirror ? 'Copy it like a mirror' : 'Copy the signer'}
                {camera ? ' and watch for the tick.' : ', then say how it went.'}
              </p>
            )}
            <div className="sign-cam">
              {camera ? (
                <PracticeView onSettled={noop} video={video} onState={setCam} className={signed ? 'matched' : ''}>
                  <canvas ref={overlay} className="hands-overlay" aria-hidden="true" />
                  {check.state !== 'off' && check.state !== 'unavailable' && (
                    <p className={`check-pill ${check.state}`} role="status">
                      {check.state === 'loading' && 'Getting ready to watch your hands…'}
                      {check.state === 'watching' &&
                        (check.unframed ? 'Move back so your shoulders show' : (
                          <>
                            Watching your hands
                            <span className="check-meter" aria-hidden="true">
                              <span style={{ width: `${Math.round(check.close * 100)}%` }} />
                            </span>
                          </>
                        ))}
                      {check.state === 'matched' && (
                        <>
                          <CheckIcon size={18} /> That matches
                        </>
                      )}
                    </p>
                  )}
                </PracticeView>
              ) : (
                <div className="mirror cam-off">
                  <p>Your camera is off. Sign along anyway, or turn it on to see yourself.</p>
                  <button className="mirror-retry" onClick={() => onCamera(true)}>
                    Turn the camera on
                  </button>
                </div>
              )}
              {camera && (
                <button className="cam-toggle" onClick={() => onCamera(false)} aria-label="Turn the camera off">
                  <CameraOffIcon />
                </button>
              )}
            </div>
          </>
        )}

        {step.type === 'teach' && item && (
          <>
            <p className="teach-new">New sign</p>
            <p className="teach-word">{item.en}</p>
            {item.ur && <p className="teach-ur ur" lang="ur">{item.ur}</p>}
            {pos === 0 && (
              <p className="lesson-tip">Watch it, then sign it yourself. The turtle slows it down, and ↻ plays it again.</p>
            )}
          </>
        )}

        {step.type !== 'teach' && step.type !== 'sign' && (
          <>
            <p className="lesson-ask">
              {step.type === 'choose' && (item?.letter ? 'Which letter is this?' : 'What does this sign mean?')}
              {step.type === 'spell' && 'Which word is being spelled?'}
              {step.type === 'pick' && item && (
                <>
                  Which one {item.letter ? 'is the letter' : 'means'} <b>{item.en}</b>
                  {item.ur && <span className="ur" lang="ur">{item.ur}</span>}?
                </>
              )}
            </p>
            <div className={`answers ${step.type === 'pick' ? 'two' : ''} ${step.type === 'spell' ? 'three' : ''} ${item?.letter && step.type === 'choose' ? 'letters' : ''}`}>
              {keys.map((key, i) => {
                const it = step.type === 'choose' ? items.get(key) : undefined
                const state = !answered ? '' : i === right ? 'right' : i === chosen ? 'wrong' : 'dim'
                return (
                  <button key={`${pos}-${i}`} className={state} disabled={answered} onClick={() => respond(i)}
                    aria-label={step.type === 'pick' ? `Sign ${i + 1}` : undefined}>
                    <span className="answer-main">{step.type === 'pick' ? i + 1 : label(key)}</span>
                    {it?.ur && <span className="answer-ur ur" lang="ur">{it.ur}</span>}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      <footer ref={foot} className={`lesson-foot ${answered ? (correct ? 'right' : 'wrong') : signed ? 'right' : ''}`}>
        {signed && item && (
          <p className="verdict" role="status">
            Nicely signed
            <small>Your signing matched “{item.en}”.</small>
          </p>
        )}
        {step.type === 'sign' && !signed && (
          <div className="rate">
            <button className="secondary" onClick={() => rate(false)}>
              Not yet
            </button>
            <button className="primary" onClick={() => rate(true)}>
              Got it
            </button>
          </div>
        )}
        {answered && (
          <p className="verdict" role="status">
            {correct ? (
              'Right'
            ) : (
              <>
                {step.type === 'pick' ? `It was sign ${right + 1}` : <>It’s “{label(keys[right])}”</>}
                {entry.tries < 2 && <small>You’ll see this one again before the end.</small>}
              </>
            )}
          </p>
        )}
        {(step.type !== 'sign' || signed) && (
          <button className="primary" onClick={next} disabled={step.type !== 'teach' && step.type !== 'sign' && !answered}>
            Continue
          </button>
        )}
      </footer>
    </div>
  )
}
