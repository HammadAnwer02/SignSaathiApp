import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SignIndex } from '../signs/data'
import { buildLexicon, normalise, translate, type GlossItem } from './translate'

const index = JSON.parse(readFileSync(new URL('../../public/signs/index.json', import.meta.url), 'utf8')) as SignIndex
const lex = buildLexicon(index)

/** compact view: sign ids, or "spell:letters" */
const view = (items: GlossItem[]) =>
  items.map((it) => (it.kind === 'sign' ? it.seq.join('+') : `spell:${it.letters.map((l) => l.char).join('')}`))

describe('normalise', () => {
  it('maps Arabic letter variants and digits to Urdu forms', () => {
    expect(normalise('مي')).toBe('می')
    expect(normalise('كتاب')).toBe('کتاب')
    expect(normalise('۲۰')).toBe('20')
  })
  it('expands English contractions', () => {
    expect(normalise("I'm here, don't go")).toBe('i am here do not go')
  })
})

describe('translate', () => {
  it('drops articles and keeps signs in order', () => {
    expect(view(translate('My mother is a teacher', lex))).toEqual(['mera', 'mother', 'is', 'teacher'])
  })

  it('fingerspells words that have no sign', () => {
    const out = translate('Where is the hospital?', lex)
    expect(view(out)).toEqual(['spell:where', 'is', 'hospital'])
  })

  it('handles plurals, past tense, multi-word signs and digits', () => {
    const out = view(translate('Hammad went to the bus stop with 2 brothers', lex))
    expect(out[0]).toBe('spell:hammad')
    expect(out).toContain('bus-stop')
    expect(out).toContain('brother')
    expect(out.some((x) => x.startsWith('spell:2'))).toBe(true)
  })

  it('reads Urdu', () => {
    const out = view(translate('میں اسکول جا رہا ہوں', lex))
    expect(out[0]).toBe('i_me')
    expect(out[1]).toBe('school')
  })

  it('returns nothing for empty input', () => {
    expect(translate('   ', lex)).toEqual([])
  })
})
