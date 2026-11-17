import { useDeferredValue, useMemo, useState } from 'react'
import type { SignEntry, SignIndex } from '../signs/data'
import { normalise, signLabel } from '../text/translate'
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

  const shown = useMemo(() => {
    const kindOk = (s: SignEntry) => (filter === 'letter' ? s.kind.startsWith('letter') : s.kind === filter)
    if (q) {
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
    }
    return rows.filter((r) => kindOk(r.sign))
  }, [rows, q, filter])

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
      {!q && (
        <div className="filters" role="tablist" aria-label="Kind of sign">
          {FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={filter === f.key} className={filter === f.key ? 'on' : ''}
              onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      {shown.length ? (
        <ul className="signs">
          {shown.map((r) => (
            <li key={r.sign.id}>
              <button
                className={`sign-row ${activeId === r.sign.id ? 'on' : ''}`}
                disabled={!ready}
                onClick={() => {
                  tap()
                  onPlay(r.sign.id)
                }}
              >
                <span className="en">
                  {r.en}
                  {r.note && <small>{r.note}</small>}
                </span>
                {r.ur && <span className="ur" lang="ur">{r.ur}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">No sign matches “{query}”. Try another spelling, or type it on the Translate tab to fingerspell it.</p>
      )}
    </div>
  )
}
