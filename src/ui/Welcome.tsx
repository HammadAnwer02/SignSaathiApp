import { useEffect, useRef } from 'react'
import logo from '../assets/logo.svg'
import { hideSplash, tap } from '../native'

/** First-launch screen, after the landing page in the Figma file. The avatar loads behind it. */
export function Welcome({ onContinue }: { onContinue: () => void }) {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // move VoiceOver/keyboard focus into the dialog without drawing a focus ring on a touch screen
    root.current?.focus({ preventScroll: true })
    // lift the launch screen only once this has painted, so the app behind never flashes first
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => hideSplash())
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div ref={root} tabIndex={-1} className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <img className="welcome-logo" src={logo} alt="Sign Saathi" width={250} height={250} />
      <h1 id="welcome-title">
        Bridging Silence,
        <br />
        Building Connections
      </h1>
      <p>Type a sentence in English or Urdu and the avatar signs it in Pakistan Sign Language. It all works offline.</p>
      <div className="welcome-actions">
        <button
          className="primary"
          onClick={() => {
            tap()
            onContinue()
          }}
        >
          Continue
        </button>
        <p className="welcome-note">Signs are read from videos by software. For anything important, check with a Deaf signer.</p>
      </div>
    </div>
  )
}
