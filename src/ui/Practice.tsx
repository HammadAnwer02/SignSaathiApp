// Practise along: the signer and your own camera as two panels of the same size, so you can copy each sign and
// check yourself, with every control in one bar underneath.

import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useCamera, useWakeLock, type CameraState } from './useCamera'
import { LettersIcon, MirrorIcon, RepeatIcon, StopIcon } from './icons'
import { SpeedStepper } from './Speed'
import { isNative, tap } from '../native'

export interface PracticeChip {
  text: string
  spelled: boolean
}

const isUrdu = (s: string) => /[؀-ۿ]/.test(s)

interface ViewProps {
  /** the camera has settled (on or not), so the first repetition can start */
  onSettled: () => void
  /** the video element, for watching the picture as well as showing it */
  video?: RefObject<HTMLVideoElement | null>
  onState?: (state: CameraState) => void
  className?: string
  /** shown over the picture while the camera is live */
  children?: ReactNode
}

/** Your camera, shown like a mirror. */
export function PracticeView({ onSettled, video: given, onState, className, children }: ViewProps) {
  const own = useRef<HTMLVideoElement>(null)
  const video = given ?? own
  const { state, retry } = useCamera(video)
  useWakeLock()

  const settled = useRef(false)
  useEffect(() => {
    if (state === 'starting' || settled.current) return
    settled.current = true
    onSettled()
  }, [state, onSettled])

  useEffect(() => {
    onState?.(state)
  }, [state, onState])

  return (
    <section className={`mirror ${className ?? ''}`} aria-label="Your camera">
      <video ref={video} playsInline muted autoPlay aria-label="Your camera, shown like a mirror" />
      {state === 'live' && children}
      {state !== 'live' && (
        <div className="mirror-status" role="status">
          <p>{STATUS[state]}</p>
          {(state === 'failed' || (state === 'blocked' && !isNative)) && (
            <button className="mirror-retry" onClick={retry}>
              Try again
            </button>
          )}
        </div>
      )}
      {state === 'live' && <p className="mirror-note">Only you see this. Nothing is recorded.</p>}
    </section>
  )
}

const STATUS: Record<Exclude<ReturnType<typeof useCamera>['state'], 'live'>, string> = {
  starting: 'Starting your camera…',
  blocked: isNative
    ? 'Sign Saathi isn’t allowed to use the camera. Turn on Camera for Sign Saathi in the Settings app to see yourself here.'
    : 'The camera is blocked for this page. Allow it in your browser’s site settings, then try again.',
  missing: 'There’s no front camera here, but you can still sign along with the avatar.',
  failed: 'The camera stopped. It may be in use by another app.',
}

interface BarProps {
  chips: PracticeChip[]
  /** the chip being practised, or -1 for the whole sentence */
  target: number
  /** the chip being signed this moment, or -1 */
  active: number
  disabled: boolean
  onChip: (i: number) => void
  /** play every chip in turn; offered when there is more than one */
  onWhole?: () => void
  speed: number
  onSpeed: (s: number) => void
  /** a sign is playing, or the next repetition is about to start */
  looping: boolean
  onPlay: () => void
  onStop: () => void
  mirror: boolean
  onMirror: () => void
  onDone: () => void
}

/** Takes the tab bar's place while practising: what to practise, then the controls. */
export function PracticeBar(props: BarProps) {
  const { chips, target, active, disabled, onChip, onWhole, speed, onSpeed, looping, onPlay, onStop, mirror, onMirror, onDone } = props

  // keep the chip being signed in view as a long sentence plays
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const row = list.current
    const chip = row?.querySelector<HTMLElement>('.now, .on')
    if (!row || !chip) return
    // scroll only the row: scrollIntoView would also nudge the page sideways
    row.scrollTo({ left: chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' })
  }, [active, target])

  // one sign on its own needs no picking: the caption already names it
  const choice = chips.length > 1 || !!onWhole

  return (
    <div className="practice-bar">
      {choice && (
        <ol className="chips practice-chips" ref={list} aria-label="Signs to practise">
          {onWhole && (
            <li>
              <button className={`chip whole ${target === -1 ? 'on' : ''}`} disabled={disabled}
                onClick={() => {
                  tap()
                  onWhole()
                }}>
                Whole sentence
              </button>
            </li>
          )}
          {chips.map((c, i) => (
            <li key={i}>
              <button
                className={`chip ${c.spelled ? 'spelled' : ''} ${i === target ? 'on' : ''} ${target === -1 && i === active ? 'now' : ''}`}
                disabled={disabled}
                aria-label={c.spelled ? `${c.text}, fingerspelled` : c.text}
                onClick={() => {
                  tap()
                  onChip(i)
                }}
              >
                <span className={isUrdu(c.text) ? 'ur' : undefined}>{c.text}</span>
                {c.spelled && <LettersIcon />}
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className="practice-tools" role="toolbar" aria-label="Practice">
        <button className="tool done" onClick={onDone}>
          Done
        </button>
        <SpeedStepper speed={speed} onSpeed={onSpeed} />
        {looping ? (
          <button className="tool play" aria-label="Stop"
            onClick={() => {
              tap()
              onStop()
            }}>
            <StopIcon />
          </button>
        ) : (
          <button className="tool play" aria-label="Sign it on repeat" disabled={disabled}
            onClick={() => {
              tap()
              onPlay()
            }}>
            <RepeatIcon size={22} />
          </button>
        )}
        <button className={`tool mirror-toggle ${mirror ? 'on' : ''}`} aria-pressed={mirror}
          onClick={() => {
            tap()
            onMirror()
          }}>
          <MirrorIcon size={22} />
          <span className="tool-label">Mirror</span>
        </button>
      </div>
    </div>
  )
}
