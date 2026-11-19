import { describe, expect, it } from 'vitest'
import { COURSE, lessonsOf, letterId, type Item, type Unit } from './course'
import { buildLesson, buildReview, type Course } from './lesson'
import {
  daysBetween, dateKey, dueItems, finishSession, freshProgress, recall, remember, streakNow, xpFor, type Progress,
} from './progress'

const DAY = 86_400_000
const at = (date: string, hour = 12) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`).getTime()

/** a seeded random, so a failing case can be replayed */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

function course(): Course {
  const items = new Map<string, Item>()
  for (const u of COURSE) for (const id of u.signs) {
    const letter = id.endsWith('_single-handed-letter')
    items.set(id, { id, en: letter ? id[0].toUpperCase() : id, letter })
  }
  return { units: COURSE as Unit[], items }
}

describe('course', () => {
  it('splits units into lessons of three or four', () => {
    const sizes = (n: number) => lessonsOf({ id: 'x', title: '', ur: '', signs: Array.from({ length: n }, (_, i) => `s${i}`) }).map((l) => l.length)
    expect(sizes(13)).toEqual([4, 3, 3, 3])
    expect(sizes(9)).toEqual([3, 3, 3])
    expect(sizes(8)).toEqual([4, 4])
    expect(sizes(6)).toEqual([3, 3])
  })

  it('teaches each sign once', () => {
    const all = COURSE.flatMap((u) => u.signs)
    expect(new Set(all).size).toBe(all.length)
    expect(all).toContain(letterId('z'))
  })
})

describe('progress', () => {
  it('counts calendar days across month ends and clock changes', () => {
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(dateKey(at('2026-11-19', 23))).toBe('2026-11-19')
  })

  it('keeps a streak going day to day, uses a freeze for a missed day, and resets after a longer gap', () => {
    let p: Progress = freshProgress()
    p = finishSession(p, 15, at('2026-11-01'))
    expect(p.streak.count).toBe(1)
    p = finishSession(p, 10, at('2026-11-01', 20))
    expect(p.streak.count).toBe(1)
    expect(p.today.xp).toBe(25)
    for (let d = 2; d <= 7; d++) p = finishSession(p, 10, at(`2026-11-0${d}`))
    expect(p.streak).toMatchObject({ count: 7, freezes: 1 })
    expect(p.today).toEqual({ date: '2026-11-07', xp: 10 })
    // miss the 8th: the freeze covers it
    expect(streakNow(p, at('2026-11-09')).count).toBe(7)
    p = finishSession(p, 10, at('2026-11-09'))
    expect(p.streak).toMatchObject({ count: 8, freezes: 0 })
    // miss two days with no freeze left
    expect(streakNow(p, at('2026-11-12')).count).toBe(0)
    p = finishSession(p, 10, at('2026-11-12'))
    expect(p.streak.count).toBe(1)
    expect(p.xp).toBe(25 + 60 + 10 + 10)
  })

  it('says whether today is done', () => {
    const p = finishSession(freshProgress(), 10, at('2026-11-01'))
    expect(streakNow(p, at('2026-11-01', 22))).toEqual({ count: 1, doneToday: true })
    expect(streakNow(p, at('2026-11-02'))).toEqual({ count: 1, doneToday: false })
  })

  it('remembers: half recalled after one half-life, right answers stretch it, wrong ones shrink it', () => {
    const now = at('2026-11-01')
    const m = remember(undefined, true, now)
    expect(m.h).toBe(1)
    expect(recall(m, now + DAY)).toBeCloseTo(0.5)
    expect(remember(m, true, now + DAY).h).toBe(2)
    expect(remember(m, true, now + 60_000).h).toBeCloseTo(1.2) // practised again straight away
    expect(remember(m, false, now + DAY).h).toBe(0.5)
    expect(remember({ h: 0.5, t: now }, false, now + DAY).h).toBe(0.5)
  })

  it('lists slipping signs weakest first', () => {
    const now = at('2026-11-10')
    const p = { ...freshProgress(), mem: { a: { h: 1, t: now - 3 * DAY }, b: { h: 1, t: now - 1.5 * DAY }, c: { h: 4, t: now - DAY } } }
    expect(dueItems(p, now)).toEqual(['a', 'b'])
  })

  it('gives a bonus for a lesson with no mistakes', () => {
    expect(xpFor(0)).toBe(15)
    expect(xpFor(2)).toBe(10)
  })
})

describe('lessons', () => {
  const c = course()
  const now = at('2026-11-10')

  it('teaches every new sign, then asks about each one with real choices', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const steps = buildLesson(c, 0, 0, freshProgress(), now, seeded(seed))
      const fresh = lessonsOf(COURSE[0])[0]
      expect(steps.filter((s) => s.type === 'teach').map((s) => s.type === 'teach' && s.item)).toEqual(fresh)
      for (const id of fresh) expect(steps.filter((s) => s.type !== 'teach' && s.type !== 'spell' && s.item === id).length).toBeGreaterThan(0)
      for (const s of steps) {
        if (s.type === 'choose') {
          expect(s.options).toContain(s.item)
          expect(new Set(s.options).size).toBe(4)
        }
        if (s.type === 'pick') {
          expect(s.order).toContain(s.item)
          expect(s.order[0]).not.toBe(s.order[1])
        }
      }
      // nothing is asked before it has been taught
      const seen = new Set<string>()
      for (const s of steps) {
        if (s.type === 'teach') seen.add(s.item)
        else if (s.type !== 'spell') expect(seen.has(s.item)).toBe(true)
      }
    }
  })

  it('ends with signing each new sign yourself', () => {
    const steps = buildLesson(c, 2, 0, freshProgress(), now, seeded(5))
    const fresh = lessonsOf(COURSE[2])[0]
    const tail = steps.slice(-fresh.length)
    expect(tail).toEqual(fresh.map((item) => ({ type: 'sign', item })))
    expect(steps.filter((s) => s.type === 'sign')).toHaveLength(fresh.length)
    // reviews stay quick: no signing yourself there
    const p = { ...freshProgress(), mem: { mother: { h: 1, t: now - 4 * DAY } } }
    expect(buildReview(c, p, now, seeded(5)).some((s) => s.type === 'sign')).toBe(false)
  })

  it('keeps letters with letters and spells only with letters met so far', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const steps = buildLesson(c, 1, 0, freshProgress(), now, seeded(seed))
      const spell = steps.find((s) => s.type === 'spell')
      expect(spell).toBeTruthy()
      if (spell?.type === 'spell') {
        for (const w of spell.options) expect([...w].every((ch) => 'abcd'.includes(ch))).toBe(true)
        expect(spell.options).toContain(spell.word)
      }
      for (const s of steps) if (s.type === 'choose') for (const o of s.options) expect(c.items.get(o)?.letter).toBe(true)
    }
  })

  it('brings back earlier signs that are slipping', () => {
    const p = { ...freshProgress(), mem: { mother: { h: 1, t: now - 4 * DAY }, good: { h: 30, t: now - DAY } } }
    const steps = buildLesson(c, 2, 1, p, now, seeded(3))
    expect(steps.some((s) => s.type !== 'teach' && s.type !== 'spell' && s.item === 'mother')).toBe(true)
    expect(steps.some((s) => s.type !== 'teach' && s.type !== 'spell' && s.item === 'good')).toBe(false)
    const review = buildReview(c, p, now, seeded(3))
    expect(review.map((s) => s.type !== 'spell' && s.item)).toEqual(['mother'])
  })
})
