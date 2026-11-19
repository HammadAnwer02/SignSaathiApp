// Your progress, kept on this device: lessons done, how well each sign is remembered, XP and the streak.

export interface Memory {
  /** half-life in days: after this long there's an even chance the sign has slipped */
  h: number
  /** last practised, ms */
  t: number
}

export interface Progress {
  v: 1
  /** lessons finished, by unit id */
  done: Record<string, number>
  mem: Record<string, Memory>
  xp: number
  /** XP earned on `date` (a local calendar day) */
  today: { date: string; xp: number }
  /** XP a day */
  goal: number
  /** days in a row with a lesson or review; a freeze covers one missed day */
  streak: { count: number; last: string; freezes: number }
}

export const GOALS = [10, 20, 30]
const DAY = 86_400_000

export function freshProgress(): Progress {
  return { v: 1, done: {}, mem: {}, xp: 0, today: { date: '', xp: 0 }, goal: 20, streak: { count: 0, last: '', freezes: 0 } }
}

export function parseProgress(raw: string | null): Progress {
  try {
    const p = JSON.parse(raw ?? '')
    if (p && p.v === 1) return { ...freshProgress(), ...p }
  } catch {
    /* start afresh */
  }
  return freshProgress()
}

/** the local calendar day, YYYY-MM-DD */
export function dateKey(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** whole days from one calendar day to another */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY)
}

/** the chance a sign is still remembered, 0 to 1 */
export function recall(m: Memory, now: number): number {
  return Math.pow(2, -Math.max(0, now - m.t) / (m.h * DAY))
}

/** after an answer: right makes the memory last about twice as long (less if it was only just practised), wrong halves it */
export function remember(m: Memory | undefined, right: boolean, now: number): Memory {
  if (!m) return { h: right ? 1 : 0.5, t: now }
  const gain = right ? (recall(m, now) > 0.8 ? 1.2 : 2) : 0.5
  return { h: Math.min(180, Math.max(0.5, m.h * gain)), t: now }
}

/** learned signs that have more likely slipped than not, weakest first */
export function dueItems(p: Progress, now: number): string[] {
  return Object.entries(p.mem)
    .map(([id, m]) => [id, recall(m, now)] as const)
    .filter(([, r]) => r < 0.5)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id)
}

/** the streak as it stands today: missed days that freezes can cover keep it alive */
export function streakNow(p: Progress, now: number): { count: number; doneToday: boolean } {
  const s = p.streak
  if (!s.last) return { count: 0, doneToday: false }
  const gap = daysBetween(s.last, dateKey(now))
  return { count: gap <= 1 + s.freezes ? s.count : 0, doneToday: gap <= 0 }
}

export function xpToday(p: Progress, now: number): number {
  return p.today.date === dateKey(now) ? p.today.xp : 0
}

/** 10 XP for a lesson or review, 5 more with no mistakes */
export const xpFor = (mistakes: number) => 10 + (mistakes === 0 ? 5 : 0)

/** A lesson or review finished: add the XP and move the streak on. */
export function finishSession(p: Progress, earned: number, now: number): Progress {
  const today = dateKey(now)
  const s = { ...p.streak }
  const gap = s.last ? daysBetween(s.last, today) : Infinity
  if (gap > 0) {
    if (gap === 1) s.count += 1
    else if (gap - 1 <= s.freezes) {
      s.freezes -= gap - 1
      s.count += 1
    } else s.count = 1
    s.last = today
    // a freeze for every week kept up, two at most
    if (s.count % 7 === 0) s.freezes = Math.min(2, s.freezes + 1)
  }
  return { ...p, xp: p.xp + earned, today: { date: today, xp: xpToday(p, now) + earned }, streak: s }
}
