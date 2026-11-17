import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AvatarStage, type Caption } from './ui/AvatarStage'
import { TranslatePanel } from './ui/TranslatePanel'
import { DictionaryPanel } from './ui/DictionaryPanel'
import { AboutPanel } from './ui/AboutPanel'
import { TabBar, type Tab } from './ui/TabBar'
import type { AvatarEngine } from './avatar/engine'
import { loadIndex, type SignIndex } from './signs/data'
import { buildLexicon, signLabel, translate, type GlossItem } from './text/translate'
import { hideSplash, prefs } from './native'

/** One playable step: a sign, or one letter of a fingerspelled word. */
export interface Unit {
  item: number
  id: string
  letter?: number
}

interface Performance {
  items: GlossItem[]
  units: Unit[]
  source: 'translate' | 'dictionary'
  /** position of items[0] in the typed sentence, so replaying one chip highlights that chip */
  first: number
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

  useEffect(() => {
    loadIndex().then(setIndex, () => setDataError(true))
    prefs.get('speed').then((v) => v && setSpeedState(Number(v)))
  }, [])

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

  const perform = useCallback((items: GlossItem[], source: Performance['source'], first = 0) => {
    const engine = engineRef.current
    const units = toUnits(items)
    setPerf({ items, units, source, first })
    if (!engine || !units.length) return
    engine.speed = speed
    engine.play(units.map((u, i) => ({ id: u.id, chip: i, letter: u.letter !== undefined })))
  }, [speed])

  const submit = useCallback((text: string) => {
    if (!lex) return
    const items = translate(text, lex)
    setSentence({ text, items })
    perform(items, 'translate')
  }, [lex, perform])

  const stop = useCallback(() => engineRef.current?.stop(), [])

  const caption: Caption | null = useMemo(() => {
    if (!perf || active < 0 || !lex) return null
    const unit = perf.units[active]
    if (!unit) return null
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
    if (perf) perform(perf.items, perf.source, perf.first)
  }, [perf, perform])

  const activeUnit = perf && active >= 0 ? perf.units[active] : undefined
  const activeItem = perf && activeUnit ? perf.first + activeUnit.item : -1

  return (
    <div className={`app tab-${tab}`}>
      <header className="masthead">
        <span className="wordmark">Sign Saathi</span>
        <span className="wordmark-ur ur" lang="ur">سائن ساتھی</span>
      </header>

      <AvatarStage
        onEngine={onEngine}
        caption={caption}
        playing={playing}
        canReplay={!!perf?.units.length}
        speed={speed}
        onSpeed={setSpeed}
        onReplay={replay}
        onStop={stop}
      />

      <main className="panel">
        {dataError ? (
          <p className="notice">The sign data didn't load. Close and reopen the app to try again.</p>
        ) : tab === 'translate' ? (
          <TranslatePanel
            ready={ready && !!lex}
            sentence={sentence}
            activeItem={perf?.source === 'translate' ? activeItem : -1}
            onSubmit={submit}
            onPlayItem={(i) => sentence && perform([sentence.items[i]], 'translate', i)}
            lexicon={lex}
          />
        ) : tab === 'dictionary' ? (
          <DictionaryPanel
            index={index}
            ready={ready}
            activeId={perf?.source === 'dictionary' && playing ? perf.units[0]?.id : undefined}
            onPlay={(id) => {
              const s = lex?.signs.get(id)
              if (s) perform([{ kind: 'sign', text: signLabel(s).en, seq: [id], alts: [] }], 'dictionary')
            }}
          />
        ) : (
          <AboutPanel index={index} />
        )}
      </main>

      <TabBar tab={tab} onTab={setTab} />
    </div>
  )
}
