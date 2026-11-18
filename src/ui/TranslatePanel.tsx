import { useEffect, useRef, useState } from 'react'
import type { GlossItem } from '../text/translate'
import { ClearIcon, LettersIcon, RecentIcon, SendIcon } from './icons'
import { tap } from '../native'

const EXAMPLES = [
  { text: 'How are you?', lang: 'en' },
  { text: 'My mother is a teacher', lang: 'en' },
  { text: 'میں اسکول جا رہا ہوں', lang: 'ur' },
  { text: 'Where is the hospital?', lang: 'en' },
  { text: 'آپ کا نام کیا ہے', lang: 'ur' },
]

const isUrdu = (s: string) => /[؀-ۿ]/.test(s)

interface Props {
  ready: boolean
  sentence: { text: string; items: GlossItem[] } | null
  activeItem: number
  recent: string[]
  onSubmit: (text: string) => void
  onPlayItem: (i: number) => void
  /** start over: forget the signed sentence and show the suggestions again */
  onClear: () => void
  onForgetRecent: () => void
}

export function TranslatePanel({ ready, sentence, activeItem, recent, onSubmit, onPlayItem, onClear, onForgetRecent }: Props) {
  const [text, setText] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [text])

  const send = (value = text) => {
    const v = value.trim()
    if (!v || !ready) return
    tap()
    onSubmit(v)
    input.current?.blur()
  }

  const pick = (value: string) => {
    setText(value)
    send(value)
  }

  return (
    <div className="translate">
      <div className="sentence">
        {sentence ? (
          sentence.items.length ? (
            <ol className="chips" aria-label="Signs in this sentence">
              {sentence.items.map((it, i) => (
                <li key={i}>
                  <button
                    className={`chip ${it.kind === 'spell' ? 'spelled' : ''} ${i === activeItem ? 'on' : ''}`}
                    onClick={() => {
                      tap()
                      onPlayItem(i)
                    }}
                    aria-label={it.kind === 'spell' ? `${it.text}, fingerspelled` : it.text}
                  >
                    <span className={isUrdu(it.text) ? 'ur' : undefined}>{it.text}</span>
                    {it.kind === 'spell' && <LettersIcon />}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="hint">None of those words are in the dictionary yet, and they couldn't be fingerspelled.</p>
          )
        ) : (
          <div className="examples">
            <p className="hint">Type a sentence and the avatar signs it. Words without a sign are fingerspelled.</p>

            {recent.length > 0 && (
              <section aria-labelledby="recent-title">
                <h2 className="section-title" id="recent-title">
                  Recent
                  <button onClick={onForgetRecent} aria-label="Clear recent sentences">
                    Clear
                  </button>
                </h2>
                <ul className="recents">
                  {recent.map((r) => (
                    <li key={r}>
                      <button className="recent" disabled={!ready} onClick={() => pick(r)}>
                        <RecentIcon />
                        <span className={isUrdu(r) ? 'ur' : undefined} lang={isUrdu(r) ? 'ur' : undefined}>
                          {r}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section aria-labelledby="try-title">
              <h2 className="section-title" id="try-title">
                Try one
              </h2>
              <ul className="suggestions">
                {EXAMPLES.map((e) => (
                  <li key={e.text}>
                    <button
                      className={`suggestion ${e.lang === 'ur' ? 'ur' : ''}`}
                      lang={e.lang}
                      disabled={!ready}
                      onClick={() => pick(e.text)}
                    >
                      {e.text}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <div className="field">
          <textarea
            ref={input}
            rows={1}
            value={text}
            dir="auto"
            enterKeyHint="go"
            placeholder="Type in English or اردو"
            aria-label="Sentence to sign"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {(text || sentence) && (
            <button
              type="button"
              className="clear"
              aria-label="Start a new sentence"
              // keep the keyboard as it was: up if you were typing, down so the suggestions show if not
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                tap()
                setText('')
                onClear()
              }}
            >
              <ClearIcon />
            </button>
          )}
          <button className="send" type="submit" disabled={!ready || !text.trim()} aria-label="Sign it">
            <SendIcon />
          </button>
        </div>
      </form>
    </div>
  )
}
