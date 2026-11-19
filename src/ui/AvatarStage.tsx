import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AvatarEngine } from '../avatar/engine'
import { SIGNERS, type Signer, type SignerId } from '../avatar/signers'
import { CameraIcon, ReplayIcon, StopIcon } from './icons'
import { hideSplash, tap } from '../native'
import { SpeedStepper } from './Speed'

export type Caption =
  | { primary: string; urdu?: string; note?: string; quality?: string; letter?: undefined }
  | { letter: string; letters: string[]; letterIndex: number; primary?: undefined }

/** how far the buttons over the top of the stage reach down, which the framing keeps the signer's head clear of */
const CONTROLS_PX = 60
/** practising, the stage is a panel with nothing over it: just a little air above the head */
const PANEL_TOP_PX = 14

interface Props {
  signer: Signer
  /** false until the saved signer choice is known */
  loadSigner: boolean
  onSigner: (id: SignerId) => void
  onEngine: (e: AvatarEngine) => void
  caption: Caption | null
  playing: boolean
  canReplay: boolean
  /** the Practise button: not offered in lessons, where its word chips would give the answers away */
  canPractise: boolean
  speed: number
  onSpeed: (s: number) => void
  onReplay: () => void
  onStop: () => void
  /** open practice: the signer and your camera as two panels. Offered once there is something to practise. */
  onPractice: () => void
  practising: boolean
  /** flip the signer left to right, so it can be copied like a mirror */
  mirrored: boolean
}

export function AvatarStage(props: Props) {
  const { signer, loadSigner, onSigner, onEngine, caption, playing, canReplay, speed, onSpeed, onReplay, onStop } = props
  const { onPractice, practising, mirrored, canPractise } = props
  const host = useRef<HTMLDivElement>(null)
  const engineRef = useRef<AvatarEngine | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    const engine = new AvatarEngine(host.current!)
    engineRef.current = engine
    ;(window as unknown as { __engine?: AvatarEngine }).__engine = engine
    return () => {
      engine.dispose()
      engineRef.current = null
    }
  }, [])

  // load the chosen signer, and swap it in place when the choice changes
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !loadSigner) return
    let live = true
    setState('loading')
    engine
      .load(signer.url)
      .then(() => {
        if (!live) return
        setState('ready')
        onEngine(engine)
      })
      .catch((err) => {
        if (!live) return
        console.error(err)
        setState('error')
        hideSplash() // otherwise the launch screen would cover the error for good
      })
    return () => {
      live = false
    }
  }, [signer.url, loadSigner, onEngine])

  // before the stage's new size is measured, so the reframe happens once
  useLayoutEffect(() => {
    engineRef.current?.setTopClear(practising ? PANEL_TOP_PX : CONTROLS_PX)
  }, [practising])

  return (
    <section className={`stage ${mirrored ? 'mirrored' : ''}`} aria-label="Signing avatar">
      <div className="stage-canvas" ref={host} />
      {state !== 'ready' && (
        <p className="stage-status" role="status">
          {state === 'loading' ? 'Getting the signer ready…' : 'The avatar could not load. Close and reopen the app.'}
        </p>
      )}

      {/* practising, the controls live in the bar under your camera */}
      {!practising && SIGNERS.length > 1 && (
        <div className="signer" role="radiogroup" aria-label="Signer">
          {SIGNERS.map((s) => (
            <button
              key={s.id}
              role="radio"
              aria-checked={signer.id === s.id}
              className={signer.id === s.id ? 'on' : ''}
              onClick={() => {
                if (signer.id === s.id) return
                tap()
                onSigner(s.id)
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {!practising && (
        <div className="stage-controls">
          <SpeedStepper speed={speed} onSpeed={onSpeed} />
          {playing ? (
            <button className="round" onClick={onStop} aria-label="Stop signing">
              <StopIcon />
            </button>
          ) : (
            <button className="round" onClick={onReplay} disabled={!canReplay} aria-label="Sign it again">
              <ReplayIcon />
            </button>
          )}
        </div>
      )}

      {!practising && canPractise && (
        <button className="practise" onClick={() => {
          tap()
          onPractice()
        }}>
          <CameraIcon />
          Practise
        </button>
      )}

      <div className="caption" aria-live="polite">
        {caption?.letter !== undefined ? (
          <>
            <span className="caption-letter">{caption.letter}</span>
            <span className="caption-spelled" aria-label={`Fingerspelling ${caption.letters.join('')}`}>
              {caption.letters.map((ch, i) => (
                <span key={i} className={i === caption.letterIndex ? 'cur' : ''}>
                  {ch}
                </span>
              ))}
            </span>
          </>
        ) : caption ? (
          <>
            <span className="caption-word">{caption.primary}</span>
            {caption.urdu && (
              <span className="caption-ur ur" lang="ur">
                {caption.urdu}
              </span>
            )}
          </>
        ) : null}
      </div>
    </section>
  )
}
