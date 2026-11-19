// Builds a lesson or a review as a list of steps.

import { lessonsOf, SPELL_WORDS, type Item, type Unit } from './course'
import { dueItems, type Progress } from './progress'

export type Step =
  /** meet a new sign */
  | { type: 'teach'; item: string }
  /** watch the sign, pick what it means */
  | { type: 'choose'; item: string; options: string[] }
  /** see what it means, pick which of two signs it is */
  | { type: 'pick'; item: string; order: [string, string] }
  /** watch a word fingerspelled, pick the word */
  | { type: 'spell'; word: string; options: string[] }
  /** sign it yourself along with the signer, with your camera as a mirror, and say how it went */
  | { type: 'sign'; item: string }

export interface Course {
  units: Unit[]
  items: Map<string, Item>
}

function shuffle<T>(list: T[], rand: () => number): T[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Exercises for signs, with wrong answers drawn from what the learner has met, nearest first. */
function exercises(course: Course, p: Progress, taughtNow: string[], rand: () => number) {
  const known = new Set([...Object.keys(p.mem), ...taughtNow])
  const unitOf = new Map<string, string[]>()
  for (const u of course.units) for (const id of u.signs) unitOf.set(id, u.signs)
  const label = (id: string) => course.items.get(id)?.en ?? id

  /** others like `id` (sign or letter): `first`, then its unit's known signs, anything known, its unit, the course */
  function others(id: string, want: number, first: string[] = []): string[] {
    const letter = course.items.get(id)?.letter
    const unit = unitOf.get(id) ?? []
    const tiers = [first, shuffle(unit.filter((x) => known.has(x)), rand), shuffle([...known], rand), shuffle(unit, rand),
      shuffle([...course.items.keys()], rand)]
    const out: string[] = []
    const labels = new Set([label(id)])
    for (const tier of tiers) {
      for (const x of tier) {
        if (out.length >= want) return out
        if (x === id || course.items.get(x)?.letter !== letter || labels.has(label(x))) continue
        labels.add(label(x))
        out.push(x)
      }
    }
    return out
  }

  const choose = (id: string, first: string[] = []): Step =>
    ({ type: 'choose', item: id, options: shuffle([id, ...others(id, 3, first)], rand) })

  const pick = (id: string): Step => {
    const [other] = others(id, 1)
    return other ? { type: 'pick', item: id, order: shuffle([id, other], rand) as [string, string] } : choose(id)
  }

  /** a word made only of letters met so far, ideally using one of `fresh` */
  function spell(fresh: string[]): Step | null {
    const letters = new Set([...known].filter((x) => course.items.get(x)?.letter).map((x) => label(x).toLowerCase()))
    const ok = SPELL_WORDS.filter((w) => [...w].every((c) => letters.has(c)))
    if (ok.length < 3) return null
    const freshLetters = new Set(fresh.map((x) => label(x).toLowerCase()))
    const withFresh = ok.filter((w) => [...w].some((c) => freshLetters.has(c)))
    const word = shuffle(withFresh.length ? withFresh : ok, rand)[0]
    return { type: 'spell', word, options: shuffle([word, ...shuffle(ok.filter((w) => w !== word), rand).slice(0, 2)], rand) }
  }

  return { choose, pick, spell }
}

/**
 * Meet the new signs two at a time, with a quick check after each pair; practise each again in a different way; spell
 * a word if letters are being learned; bring back a couple of earlier signs that are starting to slip; and last, sign
 * each new one yourself.
 */
export function buildLesson(course: Course, unitIndex: number, lessonIndex: number, p: Progress, now: number,
  rand: () => number = Math.random): Step[] {
  const fresh = lessonsOf(course.units[unitIndex])[lessonIndex] ?? []
  const ex = exercises(course, p, fresh, rand)
  const steps: Step[] = []
  for (let i = 0; i < fresh.length; i += 2) {
    const pair = fresh.slice(i, i + 2)
    pair.forEach((id) => steps.push({ type: 'teach', item: id }))
    if (pair.length === 2) {
      const [a, b] = shuffle(pair, rand)
      steps.push(ex.choose(a, [b]))
    }
  }
  shuffle(fresh, rand).forEach((id, i) => steps.push(i % 2 === 0 ? ex.pick(id) : ex.choose(id)))
  if (fresh.some((id) => course.items.get(id)?.letter)) {
    const s = ex.spell(fresh)
    if (s) steps.push(s)
  }
  dueItems(p, now)
    .filter((id) => course.items.has(id) && !fresh.includes(id))
    .slice(0, 2)
    .forEach((id, i) => steps.push(i % 2 === 0 ? ex.choose(id) : ex.pick(id)))
  fresh.forEach((id) => steps.push({ type: 'sign', item: id }))
  return steps
}

/** Up to eight signs that are slipping, weakest first, each asked once (plus a word to spell if letters are among them). */
export function buildReview(course: Course, p: Progress, now: number, rand: () => number = Math.random): Step[] {
  const due = dueItems(p, now).filter((id) => course.items.has(id)).slice(0, 8)
  const ex = exercises(course, p, [], rand)
  const steps = due.map((id, i) => (i % 2 === 0 ? ex.choose(id) : ex.pick(id)))
  if (due.some((id) => course.items.get(id)?.letter)) {
    const s = ex.spell(due)
    if (s) steps.push(s)
  }
  return shuffle(steps, rand)
}

/** the sign ids a step tests (a spelled word tests none on its own) */
export const stepItem = (s: Step): string | undefined => (s.type === 'spell' ? undefined : s.item)
