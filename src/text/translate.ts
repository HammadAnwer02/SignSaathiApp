// Text -> sequence of PSL signs, entirely on-device.
//
// 1. normalise (Unicode, Urdu letter variants, diacritics, digits, contractions)
// 2. longest-match phrases from the dictionary (multi-word signs like "bus stop")
// 3. single words, trying simple English/Urdu word forms against the dictionary
// 4. numbers by exact sign, otherwise digit by digit
// 5. anything left is fingerspelled; small function words with no sign are dropped

import type { SignEntry, SignIndex, SignKind } from '../signs/data'

export interface Letter {
  id: string
  char: string
}

export type GlossItem =
  | { kind: 'sign'; text: string; seq: string[]; note?: string; alts: { seq: string[]; note?: string }[] }
  | { kind: 'spell'; text: string; letters: Letter[] }

interface LexEntry {
  seq: string[]
  primary: boolean
  note?: string
  kind: SignKind
}

export interface Lexicon {
  entries: Map<string, LexEntry[]>
  maxLen: number
  enLetters: Map<string, string>
  urLetters: Map<string, string>
  digits: Map<string, string>
  signs: Map<string, SignEntry>
}

// ------------------------------------------------------------------ normalisation

const UR_MAP: Record<string, string> = {
  'ي': 'ی', 'ى': 'ی', 'ئ': 'ئ', 'ك': 'ک', 'ه': 'ہ', 'ۀ': 'ہ', 'ة': 'ہ', 'أ': 'ا', 'إ': 'ا', 'ٱ': 'ا',
}
const DIACRITICS = /[ً-ٰٟ۪-ۭـ]/g
const PUNCT = /[.,!?;:"“”‘’()[\]{}<>/\\|@#$%^&*_+=~`۔،؟؛٫٬-]+/g

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan't\b/g, 'can not'],
  [/\bwon't\b/g, 'will not'],
  [/\bi'm\b/g, 'i am'],
  [/\blet's\b/g, 'let us'],
  [/n't\b/g, ' not'],
  [/'re\b/g, ' are'],
  [/'ve\b/g, ' have'],
  [/'ll\b/g, ' will'],
  [/'d\b/g, ' would'],
  [/\b(it|that|what|where|who|how|there|here|he|she)'s\b/g, '$1 is'],
]

export function normalise(text: string): string {
  let s = text.normalize('NFKC').toLowerCase().replace(/[’‘`]/g, "'")
  s = s.replace(/[؀-ۿ]/g, (c) => UR_MAP[c] ?? c).replace(DIACRITICS, '')
  s = s.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
  s = s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
  for (const [re, rep] of CONTRACTIONS) s = s.replace(re, rep)
  return s.replace(PUNCT, ' ').replace(/\s+/g, ' ').trim()
}

export function tokenize(text: string): string[] {
  const s = normalise(text)
  return s ? s.split(' ').map((t) => t.replace(/^'+|'+$/g, '')).filter(Boolean) : []
}

/** Display words for a sign: first English and first Urdu synonym, without disambiguation notes. */
/** Arabic-script letters (not digits), so a label like "b(double-handed-letter)" or "1" isn't taken as the Urdu */
const URDU_LETTER = /[ء-يٱ-ۓ]/

export function signLabel(s: SignEntry): { en: string; ur?: string; note?: string } {
  const [en, note] = splitNote(s.en[0] ?? s.label)
  const urAlias = s.ur.find((u) => URDU_LETTER.test(u))
  const ur = urAlias ? splitNote(urAlias)[0] : undefined
  return { en, ur, note }
}

/** "niece(brother's-daughter)" -> ["niece", "brother's-daughter"] */
export function splitNote(token: string): [string, string | undefined] {
  const m = token.match(/^(.*?)\s*\(([^)]*)\)\s*$/)
  return m ? [m[1].trim(), m[2].trim()] : [token.trim(), undefined]
}

// ------------------------------------------------------------------ lexicon

export function buildLexicon(index: SignIndex): Lexicon {
  const entries = new Map<string, LexEntry[]>()
  const enLetters = new Map<string, string>()
  const urLetters = new Map<string, string>()
  const digits = new Map<string, string>()
  const signs = new Map(index.signs.map((s) => [s.id, s]))
  let maxLen = 1

  const add = (raw: string, entry: LexEntry) => {
    const [surface, note] = splitNote(raw)
    const toks = tokenize(surface)
    if (!toks.length) return
    const key = toks.join(' ')
    maxLen = Math.max(maxLen, toks.length)
    const list = entries.get(key) ?? []
    if (!list.some((e) => e.seq.join() === entry.seq.join())) list.push({ ...entry, note })
    entries.set(key, list)
  }

  for (const s of index.signs) {
    if (s.kind === 'letter-en' || s.kind === 'letter-ur') {
      for (const raw of s.en) {
        const [surface, note] = splitNote(raw)
        if (/^[a-z]$/.test(surface) && (!enLetters.has(surface) || note?.includes('single'))) enLetters.set(surface, s.id)
      }
      for (const raw of s.ur) {
        const [surface] = splitNote(raw)
        const n = normalise(surface)
        if ([...n].length === 1 && !urLetters.has(n)) urLetters.set(n, s.id)
      }
      continue
    }
    if (s.kind === 'number' && /^\d$/.test(s.label)) digits.set(s.label, s.id)
    s.en.forEach((t, i) => add(t, { seq: [s.id], primary: i === 0, kind: s.kind }))
    s.ur.forEach((t, i) => add(t, { seq: [s.id], primary: i === 0, kind: s.kind }))
  }
  // PSL shows some digits with letter handshapes (2 = V, 3 = W); the dictionary lists them as tokens
  const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
  for (const s of index.signs) {
    for (const raw of s.en) {
      const [surface] = splitNote(raw)
      const d = /^\d$/.test(surface) ? surface : NUMBER_WORDS.indexOf(surface) >= 0 ? String(NUMBER_WORDS.indexOf(surface)) : null
      if (d !== null && !digits.has(d)) digits.set(d, s.id)
    }
  }
  for (const p of index.phrases) {
    for (const t of [...p.en, ...p.ur]) add(t, { seq: p.seq, primary: false, kind: 'word' })
  }
  for (const list of entries.values()) list.sort((a, b) => Number(b.primary) - Number(a.primary))
  return { entries, maxLen: Math.min(maxLen, 6), enLetters, urLetters, digits, signs }
}

// ------------------------------------------------------------------ word forms

const IRREGULAR: Record<string, string> = {
  went: 'go', gone: 'go', goes: 'go', did: 'do', done: 'do', does: 'do', ate: 'eat', eaten: 'eat', saw: 'see',
  seen: 'see', came: 'come', took: 'take', taken: 'take', gave: 'give', given: 'give', got: 'get', made: 'make',
  said: 'say', told: 'tell', thought: 'think', bought: 'buy', brought: 'bring', ran: 'run', wrote: 'write',
  written: 'write', sat: 'sit', stood: 'stand', slept: 'sleep', felt: 'feel', kept: 'keep', met: 'meet',
  paid: 'pay', sold: 'sell', taught: 'teach', understood: 'understand', drank: 'drink', drunk: 'drink',
  children: 'child', men: 'man', women: 'woman', people: 'person', feet: 'foot', teeth: 'tooth', mice: 'mouse',
  better: 'good', best: 'good', worse: 'bad', worst: 'bad', i: 'me', my: 'mine', our: 'we', us: 'we',
  your: 'you', his: 'he', her: 'she', their: 'they', them: 'they', him: 'he',
}

function englishForms(t: string): string[] {
  const out: string[] = []
  const push = (x: string) => x.length > 1 && !out.includes(x) && out.push(x)
  if (IRREGULAR[t]) push(IRREGULAR[t])
  if (t.endsWith("'s")) push(t.slice(0, -2))
  if (t.endsWith("s'")) push(t.slice(0, -1))
  const undouble = (x: string) => (/([b-df-hj-np-tv-z])\1$/.test(x) ? x.slice(0, -1) : x)
  if (t.endsWith('ies')) push(t.slice(0, -3) + 'y')
  if (t.endsWith('es')) push(t.slice(0, -2))
  if (t.endsWith('s') && !t.endsWith('ss')) push(t.slice(0, -1))
  if (t.endsWith('ing')) {
    const b = t.slice(0, -3)
    push(b)
    push(b + 'e')
    push(undouble(b))
  }
  if (t.endsWith('ied')) push(t.slice(0, -3) + 'y')
  if (t.endsWith('ed')) {
    const b = t.slice(0, -2)
    push(b)
    push(t.slice(0, -1))
    push(undouble(b))
  }
  for (const suf of ['est', 'er']) {
    if (t.endsWith(suf)) {
      const b = t.slice(0, -suf.length)
      push(b)
      push(b + 'e')
      push(undouble(b))
      if (b.endsWith('i')) push(b.slice(0, -1) + 'y')
    }
  }
  if (t.endsWith('ly')) push(t.slice(0, -2))
  return out
}

function urduForms(t: string): string[] {
  const out: string[] = []
  const push = (x: string) => x.length > 1 && !out.includes(x) && out.push(x)
  const strip = (suf: string) => (t.endsWith(suf) ? t.slice(0, -suf.length) : null)
  let b: string | null
  if ((b = strip('یں'))) push(b)
  if ((b = strip('وں'))) {
    push(b)
    push(b + 'ہ')
    push(b + 'ا')
  }
  if ((b = strip('ے'))) {
    push(b + 'ا')
    push(b + 'ہ')
    push(b + 'نا')
  }
  for (const suf of ['تا', 'تی', 'تے', 'یا', 'ئے', 'ئی', 'و']) {
    if ((b = strip(suf))) push(b + 'نا')
  }
  return out
}

// ------------------------------------------------------------------ translate

const DROP_ALWAYS = new Set(['a', 'an', 'the'])
const FUNCTION_WORDS = new Set([
  'of', 'to', 'for', 'be', 'been', 'being', 'is', 'am', 'are', 'was', 'were', 'do', 'does', 'did', 'will', 'shall',
  'would', 'should', 'can', 'could', 'may', 'might', 'must', 'has', 'have', 'had', 'at', 'on', 'in', 'by', 'and',
  'or', 'so', 'just', 'very', 'please',
  'کا', 'کی', 'کے', 'نے', 'کو', 'سے', 'ہے', 'ہیں', 'ہوں', 'ہو', 'تھا', 'تھی', 'تھے', 'گا', 'گی', 'گے', 'رہا',
  'رہی', 'رہے', 'بھی', 'تو', 'ہی', 'اور',
])

const isUrdu = (t: string) => /[؀-ۿ]/.test(t)

function findEntries(key: string, lex: Lexicon, single: boolean): LexEntry[] | null {
  const direct = lex.entries.get(key)
  if (direct?.length) return direct
  if (!single) return null
  for (const form of isUrdu(key) ? urduForms(key) : englishForms(key)) {
    const e = lex.entries.get(form)
    if (e?.length) return e
  }
  return null
}

function spell(text: string, lex: Lexicon): GlossItem | null {
  const letters: Letter[] = []
  for (const ch of [...text]) {
    const id = /\d/.test(ch) ? lex.digits.get(ch) : isUrdu(ch) ? lex.urLetters.get(ch) : lex.enLetters.get(ch)
    if (id) letters.push({ id, char: ch })
  }
  return letters.length ? { kind: 'spell', text, letters } : null
}

export function translate(text: string, lex: Lexicon): GlossItem[] {
  const toks = tokenize(text)
  const out: GlossItem[] = []
  let i = 0
  while (i < toks.length) {
    let used = 0
    for (let n = Math.min(lex.maxLen, toks.length - i); n >= 1; n--) {
      const key = toks.slice(i, i + n).join(' ')
      if (n === 1 && DROP_ALWAYS.has(key)) {
        used = 1
        break
      }
      const found = findEntries(key, lex, n === 1)
      if (found) {
        const [first, ...rest] = found
        out.push({ kind: 'sign', text: key, seq: first.seq, note: first.note, alts: rest.map((e) => ({ seq: e.seq, note: e.note })) })
        used = n
        break
      }
    }
    if (used) {
      i += used
      continue
    }
    const tok = toks[i++]
    if (FUNCTION_WORDS.has(tok)) continue
    const item = spell(tok, lex)
    if (item) out.push(item)
  }
  return out
}
