import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AvatarStage, type Caption } from './ui/AvatarStage'
import { TranslatePanel } from './ui/TranslatePanel'
import { DictionaryPanel } from './ui/DictionaryPanel'
import { AboutPanel } from './ui/AboutPanel'
import { TabBar, type Tab } from './ui/TabBar'
import { Welcome } from './ui/Welcome'
import { PracticeBar, PracticeView, type PracticeChip } from './ui/Practice'
import { LearnPanel } from './ui/LearnPanel'
import type { AvatarEngine } from './avatar/engine'
import { signerById, type SignerId } from './avatar/signers'
import { loadIndex, type SignIndex } from './signs/data'
import { buildLexicon, signLabel, translate, type GlossItem } from './text/translate'
import { hideSplash, prefs, tap } from './native'

const RECENT_MAX = 5
/** while practising, the rest between one repetition and the next, to get your hands ready */
const REPEAT_PAUSE_MS = 1500

function readRecent(raw: string | null): string[] {
  try {
    const list: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

/** One playable step: a sign, or one letter of a fingerspelled word. */
export interface Unit {
  item: number
  id: string
  letter?: number
}

interface Performance {
  items: GlossItem[]
  units: Unit[]
  source: 'translate' | 'dictionary' | 'learn'
  /** position of items[0] in the typed sentence, so replaying one chip highlights that chip */
  first: number
  /** a lesson's captions, one per item; a lesson shows no caption otherwise, so it doesn't give the answer away */
  captions?: string[]
}

function toUnits(items: GlossItem[]): Unit[] {
  const units: Unit[] = []
  items.forEach((it, item) => {
    if (it.kind === 'sign') it.seq.forEach((id) => units.push({ item, id }))
    else it.letters.forEach((l, letter) => units.push({ item, id: l.id, letter }))
  })
  return units
}

export function App() {
  const [index, setIndex] = useState<SignIndex | null>(null)
  const [dataError, setDataError] = useState(false)
  const lex = useMemo(() => (index ? buildLexicon(index) : null), [index])
  const engineRef = useRef<AvatarEngine | null>(null)
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<Tab>('translate')
  const [sentence, setSentence] = useState<{ text: string; items: GlossItem[] } | null>(null)
  const [perf, setPerf] = useState<Performance | null>(null)
  const [active, setActive] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeedState] = useState(0.75)
  /** null until we know whether this is the first launch */
  const [welcome, setWelcome] = useState<boolean | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const recentLoaded = useRef(false)
  /** null until the saved choice is read, so we don't download one signer only to swap it straight away */
  const [signerId, setSignerId] = useState<SignerId | null>(null)
  /** practising along: your camera under the signer, the sign repeating until you stop it, the signer mirrored */
  const [practice, setPractice] = useState(false)
  const [mirror, setMirror] = useState(true)
  /** a repetition is queued: the pause between one and the next counts as playing, so Stop shows */
  const [waiting, setWaiting] = useState(false)
  const repeatTimer = useRef<number | undefined>(undefined)
  /** a lesson is open: the signer shows above it and the tab bar steps aside */
  const [lessonLayout, setLessonLayout] = useState(false)
  const [lessonTop, setLessonTop] = useState<HTMLDivElement | null>(null)
  /** a lesson's sign-it step: the sign repeats, mirrored like practice, while you sign along */
  const [signAlong, setSignAlong] = useState(false)

  useEffect(() => {
    loadIndex().then(setIndex, () => setDataError(true))
    prefs.get('speed').then((v) => v && setSpeedState(Number(v)))
    prefs.get('signer').then((v) => setSignerId(signerById(v).id))
    prefs.get('practiceMirror').then((v) => v && setMirror(v === '1'))
    prefs.get('recent').then((v) => {
      setRecent(readRecent(v))
      recentLoaded.current = true
    })
    // first launch shows the welcome, which lifts the launch screen so people read it while the avatar loads
    prefs.get('welcomed').then((v) => setWelcome(v !== '1'))
  }, [])

  useEffect(() => {
    if (recentLoaded.current) prefs.set('recent', JSON.stringify(recent))
  }, [recent])

  const dismissWelcome = useCallback(() => {
    setWelcome(false)
    prefs.set('welcomed', '1')
  }, [])

  const cancelRepeat = useCallback(() => {
    window.clearTimeout(repeatTimer.current)
    setWaiting(false)
  }, [])

  const chooseSigner = useCallback((id: SignerId) => {
    cancelRepeat()
    engineRef.current?.stop()
    setReady(false) // until the new signer has loaded
    setSignerId(id)
    prefs.set('signer', id)
  }, [cancelRepeat])

  const setSpeed = useCallback((s: number) => {
    setSpeedState(s)
    prefs.set('speed', String(s))
  }, [])

  useEffect(() => {
    if (engineRef.current) engineRef.current.speed = speed
  }, [speed, ready])

  const onEngine = useCallback((engine: AvatarEngine) => {
    engineRef.current = engine
    engine.onChip = setActive
    engine.onPlaying = setPlaying
    setReady(true)
    hideSplash()
  }, [])

  const perform = useCallback((items: GlossItem[], source: Performance['source'], first = 0, captions?: string[]) => {
    cancelRepeat()
    const engine = engineRef.current
    const units = toUnits(items)
    setPerf({ items, units, source, first, captions })
    if (!engine || !units.length) return
    engine.speed = speed
    engine.play(units.map((u, i) => ({ id: u.id, chip: i, letter: u.letter !== undefined })))
  }, [speed, cancelRepeat])

  const submit = useCallback((text: string) => {
    if (!lex) return
    const items = translate(text, lex)
    setSentence({ text, items })
    perform(items, 'translate')
    if (items.length) setRecent((list) => [text, ...list.filter((t) => t !== text)].slice(0, RECENT_MAX))
  }, [lex, perform])

  const stop = useCallback(() => {
    cancelRepeat()
    engineRef.current?.stop()
  }, [cancelRepeat])

  const clearSentence = useCallback(() => {
    cancelRepeat()
    engineRef.current?.stop()
    setSentence(null)
    setPerf(null)
    setActive(-1)
  }, [cancelRepeat])

  const caption: Caption | null = useMemo(() => {
    if (!perf || active < 0 || !lex) return null
    const unit = perf.units[active]
    if (!unit) return null
    if (perf.source === 'learn') {
      const label = perf.captions?.[unit.item]
      return label ? { primary: label } : null
    }
    const item = perf.items[unit.item]
    if (item.kind === 'spell') {
      const i = unit.letter ?? 0
      const up = (c: string) => c.toLocaleUpperCase('en')
      return { letter: up(item.letters[i].char), letters: item.letters.map((l) => up(l.char)), letterIndex: i }
    }
    const sign = lex.signs.get(unit.id)
    if (!sign) return null
    const l = signLabel(sign)
    // show what the person typed when one sign stands for it; phrase signs show each gloss
    const typed = item.seq.length === 1 && !/[؀-ۿ]/.test(item.text) ? item.text : l.en
    const primary = typed.charAt(0).toLocaleUpperCase('en') + typed.slice(1)
    return { primary, urdu: l.ur, note: l.note, quality: sign.quality }
  }, [perf, active, lex])

  const replay = useCallback(() => {
    if (perf && ready) perform(perf.items, perf.source, perf.first, perf.captions)
  }, [perf, perform, ready])

  // ---------------------------------------------------------------- learn

  const learnPlay = useCallback((items: GlossItem[], captions?: string[]) => perform(items, 'learn', 0, captions), [perform])

  const learnEnd = useCallback(() => {
    cancelRepeat()
    engineRef.current?.stop()
    setPerf((p) => (p?.source === 'learn' ? null : p))
    setActive(-1)
    setSignAlong(false)
  }, [cancelRepeat])

  const activeUnit = perf && active >= 0 ? perf.units[active] : undefined
  const activeItem = perf && activeUnit ? perf.first + activeUnit.item : -1

  // ---------------------------------------------------------------- practice

  // when a sign plays through while practising, rest a moment and sign it again
  const queueRepeat = useCallback(() => {
    if (!practice && !signAlong) return
    window.clearTimeout(repeatTimer.current)
    setWaiting(true)
    repeatTimer.current = window.setTimeout(() => {
      setWaiting(false)
      replay()
    }, REPEAT_PAUSE_MS)
  }, [practice, signAlong, replay])

  useEffect(() => {
    const engine = engineRef.current
    if (engine) engine.onFinish = queueRepeat
  }, [queueRepeat, ready])

  useEffect(() => () => window.clearTimeout(repeatTimer.current), [])

  const endPractice = useCallback(() => {
    tap()
    cancelRepeat()
    setPractice(false)
  }, [cancelRepeat])

  const toggleMirror = useCallback(() => {
    setMirror(!mirror)
    prefs.set('practiceMirror', mirror ? '0' : '1')
  }, [mirror])

  // the first repetition starts once the camera is up (or has failed), not under the permission prompt
  const cameraSettled = useCallback(() => {
    if (!engineRef.current?.playing) replay()
  }, [replay])

  const practiceFromSentence = perf?.source === 'translate' && sentence !== null
  const practiceChips: PracticeChip[] = useMemo(() => {
    if (!perf) return []
    const items = perf.source === 'translate' && sentence ? sentence.items : perf.items
    return items.map((it) => ({ text: it.text, spelled: it.kind === 'spell' }))
  }, [perf, sentence])
  const wholeSentence = practiceFromSentence && sentence.items.length > 1 && perf.items.length === sentence.items.length
  const practiceTarget = !perf ? -1 : wholeSentence ? -1 : practiceFromSentence ? perf.first : 0

  return (
    <>
      <div className={`app tab-${tab} ${practice ? 'practising' : ''} ${lessonLayout && tab === 'learn' ? 'in-lesson' : ''}`}
        inert={!!welcome}>
        {/* a lesson's close button and progress bar, above the signer */}
        <div className="lesson-top" ref={setLessonTop} hidden={!(lessonLayout && tab === 'learn')} />
        <AvatarStage
          signer={signerById(signerId)}
          loadSigner={signerId !== null}
          onSigner={chooseSigner}
          onEngine={onEngine}
          caption={caption}
          playing={playing || waiting}
          canReplay={ready && !!perf?.units.length}
          canPractise={ready && !!perf?.units.length && tab !== 'learn'}
          speed={speed}
          onSpeed={setSpeed}
          onReplay={replay}
          onStop={stop}
          onPractice={() => setPractice(true)}
          practising={practice}
          mirrored={(practice || signAlong) && mirror}
        />

        {/* every section stays mounted with its own scroller, so switching tabs keeps what you typed,
            your search and where you had scrolled to */}
        <main className="panel">
          {dataError ? (
            <p className="notice pane">The sign data didn't load. Close and reopen the app to try again.</p>
          ) : (
            <>
              <div className="pane" hidden={tab !== 'translate'}>
                <TranslatePanel
                  ready={ready && !!lex}
                  sentence={sentence}
                  activeItem={perf?.source === 'translate' ? activeItem : -1}
                  recent={recent}
                  onSubmit={submit}
                  onPlayItem={(i) => sentence && perform([sentence.items[i]], 'translate', i)}
                  onClear={clearSentence}
                  onForgetRecent={() => setRecent([])}
                />
              </div>
              <div className="pane" hidden={tab !== 'learn'}>
                <LearnPanel
                  index={index}
                  ready={ready}
                  onPlay={learnPlay}
                  onEnd={learnEnd}
                  onLessonLayout={setLessonLayout}
                  top={lessonTop}
                  onSignAlong={setSignAlong}
                  mirror={mirror}
                />
              </div>
              <div className="pane" hidden={tab !== 'dictionary'}>
                <DictionaryPanel
                  index={index}
                  ready={ready}
                  activeId={perf?.source === 'dictionary' && playing ? perf.units[0]?.id : undefined}
                  onPlay={(id) => {
                    const s = lex?.signs.get(id)
                    if (s) perform([{ kind: 'sign', text: signLabel(s).en, seq: [id], alts: [] }], 'dictionary')
                  }}
                />
              </div>
              <div className="pane" hidden={tab !== 'about'}>
                <AboutPanel index={index} />
              </div>
            </>
          )}
        </main>

        <TabBar tab={tab} onTab={setTab} />

        {practice && (
          <>
            <PracticeView onSettled={cameraSettled} />
            <PracticeBar
              chips={practiceChips}
              target={practiceTarget}
              active={activeItem}
              disabled={!ready}
              onChip={(i) => (practiceFromSentence ? perform([sentence.items[i]], 'translate', i) : replay())}
              onWhole={practiceFromSentence && sentence.items.length > 1 ? () => perform(sentence.items, 'translate') : undefined}
              speed={speed}
              onSpeed={setSpeed}
              looping={playing || waiting}
              onPlay={replay}
              onStop={stop}
              mirror={mirror}
              onMirror={toggleMirror}
              onDone={endPractice}
            />
          </>
        )}
      </div>
      {welcome && <Welcome onContinue={dismissWelcome} />}
    </>
  )
}
