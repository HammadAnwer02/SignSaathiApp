// Signing speed, one step slower or faster at a time, so only the speed in use is on screen.

import { HareIcon, TurtleIcon } from './icons'
import { tap } from '../native'

/** the steps offered, slowest first (the engine plays any rate in between just as smoothly) */
const SPEEDS = [0.25, 0.5, 0.75, 1]
const LABELS = ['¼×', '½×', '¾×', '1×']
const NAMES = ['Quarter speed', 'Half speed', 'Three-quarter speed', 'Normal speed']

/** the step nearest a speed, so an older saved choice still lands on one */
function stepOf(speed: number) {
  let best = 0
  SPEEDS.forEach((s, i) => {
    if (Math.abs(s - speed) < Math.abs(SPEEDS[best] - speed)) best = i
  })
  return best
}

interface Props {
  speed: number
  onSpeed: (s: number) => void
}

export function SpeedStepper({ speed, onSpeed }: Props) {
  const i = stepOf(speed)
  const go = (to: number) => {
    tap()
    onSpeed(SPEEDS[to])
  }
  return (
    <div className="speed" role="group" aria-label="Signing speed">
      <button onClick={() => go(i - 1)} disabled={i === 0} aria-label="Slower">
        <TurtleIcon />
      </button>
      <output aria-live="polite">
        <span aria-hidden="true">{LABELS[i]}</span>
        <span className="sr">{NAMES[i]}</span>
      </output>
      <button onClick={() => go(i + 1)} disabled={i === SPEEDS.length - 1} aria-label="Faster">
        <HareIcon />
      </button>
    </div>
  )
}
