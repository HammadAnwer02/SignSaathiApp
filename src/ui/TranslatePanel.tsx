import { useEffect, useRef, useState } from 'react'
import type { GlossItem, Lexicon } from '../text/translate'
import { LettersIcon, SendIcon } from './icons'
import { tap } from '../native'

const EXAMPLES = [
  { text: 'How are you?', lang: 'en' },
  { text: 'My mother is a teacher', lang: 'en' },
  { text: 'میں اسکول جا رہا ہوں', lang: 'ur' },
  { text: 'Where is the hospital?', lang: 'en' },
  { text: 'آپ کا نام کیا ہے', lang: 'ur' },
]

interface Props {
  ready: boolean
  sentence: { text: string; items: GlossItem[] } | null
  activeItem: number
  lexicon: Lexicon | null
  onSubmit: (text: string) => void
  onPlayItem: (i: number) => void
}

export function TranslatePanel({ ready, sentence, activeItem, onSubmit, onPlayItem }: Props) {
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
                    <span className={/[؀-ۿ]/.test(it.text) ? 'ur' : undefined}>{it.text}</span>
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
            <ul>
              {EXAMPLES.map((e) => (
                <li key={e.text}>
                  <button
                    className={`example ${e.lang === 'ur' ? 'ur' : ''}`}
                    lang={e.lang}
                    disabled={!ready}
                    onClick={() => {
                      setText(e.text)
                      send(e.text)
                    }}
                  >
                    {e.text}
                  </button>
                </li>
              ))}
            </ul>
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
        <button className="send" type="submit" disabled={!ready || !text.trim()} aria-label="Sign it">
          <SendIcon />
        </button>
      </form>
    </div>
  )
}
