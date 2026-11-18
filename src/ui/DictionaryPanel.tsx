import { useDeferredValue, useMemo, useState } from 'react'
import type { SignEntry, SignIndex } from '../signs/data'
import { normalise, signLabel, splitNote } from '../text/translate'
import { SearchIcon } from './icons'
import { tap } from '../native'

const FILTERS = [
  { key: 'word', label: 'Words' },
  { key: 'number', label: 'Numbers' },
  { key: 'letter', label: 'Alphabet' },
] as const
type Filter = (typeof FILTERS)[number]['key']

interface Props {
  index: SignIndex | null
  ready: boolean
  activeId?: string
  onPlay: (id: string) => void
}

interface Row {
  sign: SignEntry
  en: string
  ur?: string
  note?: string
  haystack: string
}

/** What a tile shows: the letter or number large, and a short line under it. */
interface Tile {
  row: Row
  big: string
  urdu: boolean
  small?: string
  label: string
}

const HANDS: Record<string, string> = {
  'single-handed-letter': 'one hand',
  'double-handed-letter': 'two hands',
}

// lakh/crore grouping (1,00,000 = one lakh), as the numbers are written in the source data;
// CLDR's en-PK groups in thousands, so borrow the en-IN pattern for the digits
const grouped = new Intl.NumberFormat('en-IN')

function letterTile(row: Row): Tile {
  if (row.sign.kind === 'letter-ur') {
    const name = row.sign.id.replace(/-/g, ' ')
    return { row, big: row.en, urdu: true, small: name, label: `Urdu letter ${name}` }
  }
  const letter = row.en.toLocaleUpperCase('en')
  const hands = row.note ? (HANDS[row.note] ?? row.note) : undefined
  return { row, big: letter, urdu: false, small: hands, label: hands ? `${letter}, ${hands}` : letter }
}

function numberTile(row: Row): Tile {
  const n = Number(row.sign.id)
  const big = Number.isFinite(n) ? grouped.format(n) : row.en
  const word = row.sign.en.map((e) => splitNote(e)[0]).find((e) => /[a-z]/i.test(e))
  return { row, big, urdu: false, small: word, label: word ? `${big}, ${word}` : big }
}

export function DictionaryPanel({ index, ready, activeId, onPlay }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('word')
  const q = useDeferredValue(normalise(query))

  const rows = useMemo<Row[]>(() => {
    if (!index) return []
    return index.signs
      .map((sign) => {
        const l = signLabel(sign)
        return { sign, ...l, haystack: normalise([...sign.en, ...sign.ur].join(' | ')) }
      })
      .sort((a, b) => a.en.localeCompare(b.en, 'en', { numeric: true }))
  }, [index])

  const found = useMemo(() => {
    if (!q) return []
    // exact word first, then words starting with the query, then anything containing it
    const rank = (r: Row) => {
      const words = r.haystack.split(/ \| |\s+/)
      return words.includes(q) ? 0 : words.some((w) => w.startsWith(q)) ? 1 : 2
    }
    return rows
      .filter((r) => r.haystack.includes(q))
      .map((r) => [rank(r), r] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, r]) => r)
  }, [rows, q])

  const words = useMemo(() => rows.filter((r) => r.sign.kind === 'word'), [rows])

  const groups = useMemo(() => {
    if (filter === 'number') {
      const tiles = rows
        .filter((r) => r.sign.kind === 'number')
        .sort((a, b) => Number(a.sign.id) - Number(b.sign.id))
        .map(numberTile)
      return [{ title: undefined, tiles }]
    }
    if (filter === 'letter') {
      const byHands = (t: Tile) => (t.row.note === 'double-handed-letter' ? 1 : 0)
      const en = rows
        .filter((r) => r.sign.kind === 'letter-en')
        .map(letterTile)
        .sort((a, b) => a.big.localeCompare(b.big, 'en') || byHands(a) - byHands(b))
      const ur = rows.filter((r) => r.sign.kind === 'letter-ur').map(letterTile)
      return [
        { title: 'English letters', tiles: en },
        { title: 'Urdu letters', tiles: ur },
      ]
    }
    return []
  }, [rows, filter])

  const play = (id: string) => {
    tap()
    onPlay(id)
  }

  const list = (shown: Row[]) => (
    <ul className="signs">
      {shown.map((r) => (
        <li key={r.sign.id}>
          <button className={`sign-row ${activeId === r.sign.id ? 'on' : ''}`} disabled={!ready} onClick={() => play(r.sign.id)}>
            <span className="en">
              {r.en}
              {r.note && <small>{r.note}</small>}
            </span>
            {r.ur && <span className="ur" lang="ur">{r.ur}</span>}
          </button>
        </li>
      ))}
    </ul>
  )

  return (
    <div className="dictionary">
      <label className="search">
        <SearchIcon />
        <input
          type="search"
          value={query}
          dir="auto"
          placeholder={index ? `Search ${index.signs.length} signs` : 'Search signs'}
          aria-label="Search signs in English or Urdu"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {q ? (
        found.length ? (
          list(found)
        ) : (
          <p className="hint">No sign matches “{query}”. Try another spelling, or type it on the Translate tab to fingerspell it.</p>
        )
      ) : (
        <>
          <div className="filters" role="tablist" aria-label="Kind of sign">
            {FILTERS.map((f) => (
              <button key={f.key} role="tab" aria-selected={filter === f.key} className={filter === f.key ? 'on' : ''}
                onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          {filter === 'word'
            ? list(words)
            : groups.map((g) => (
                <section key={g.title ?? 'all'} aria-label={g.title ?? 'Numbers'}>
                  {g.title && <h2 className="section-title">{g.title}</h2>}
                  <ul className={`tiles ${g.title ? '' : 'untitled'}`}>
                    {g.tiles.map((t) => (
                      <li key={t.row.sign.id}>
                        <button
                          className={`tile ${activeId === t.row.sign.id ? 'on' : ''}`}
                          disabled={!ready}
                          aria-label={t.label}
                          onClick={() => play(t.row.sign.id)}
                        >
                          <b className={t.urdu ? 'ur' : undefined} lang={t.urdu ? 'ur' : undefined}>
                            {t.big}
                          </b>
                          {t.small && <small>{t.small}</small>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
        </>
      )}
    </div>
  )
}
