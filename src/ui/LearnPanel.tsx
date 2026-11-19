// The Learn tab: the course as a route of units, a review when signs start to slip, and the lessons themselves.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SignIndex } from '../signs/data'
import { courseFrom, lessonsOf } from '../learn/course'
import { buildLesson, buildReview, type Step } from '../learn/lesson'
import {
  dueItems, finishSession, GOALS, parseProgress, remember, streakNow, xpFor, xpToday, type Progress,
} from '../learn/progress'
import type { GlossItem } from '../text/translate'
import { Lesson, glossOf, type LessonResult } from './Lesson'
import { CheckIcon, FlameIcon, LockIcon } from './icons'
import { prefs, tap } from '../native'

type Session = { kind: 'lesson'; unit: number; lesson: number; steps: Step[] } | { kind: 'review'; steps: Step[] }

interface Summary {
  kind: Session['kind']
  earned: number
  /** share of answers that were right, 0 to 1 */
  score: number
  streak: number
  today: number
  goal: number
}

interface Props {
  index: SignIndex | null
  ready: boolean
  onPlay: (items: GlossItem[], captions?: string[]) => void
  /** the lesson is over: stop the signer and forget the question it showed */
  onEnd: () => void
  /** the lesson layout: the signer shows, the tab bar steps aside */
  onLessonLayout: (on: boolean) => void
  /** where a lesson puts its close button and progress bar */
  top: HTMLElement | null
  /** a lesson's sign-it step is open: the signer repeats, mirrored if practice mirrors it */
  onSignAlong: (on: boolean) => void
  mirror: boolean
}

export function LearnPanel({ index, ready, onPlay, onEnd, onLessonLayout, top, onSignAlong, mirror }: Props) {
  const course = useMemo(() => (index ? courseFrom(index) : null), [index])
  const [p, setP] = useState<Progress | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  /** your camera in the sign-it steps; some people would rather not have it on */
  const [camera, setCamera] = useState(true)

  useEffect(() => {
    prefs.get('learn').then((raw) => setP(parseProgress(raw)))
    prefs.get('learnCamera').then((v) => v && setCamera(v === '1'))
  }, [])

  const chooseCamera = useCallback((on: boolean) => {
    tap()
    setCamera(on)
    prefs.set('learnCamera', on ? '1' : '0')
  }, [])

  const save = useCallback((next: Progress) => {
    setP(next)
    prefs.set('learn', JSON.stringify(next))
  }, [])

  useEffect(() => {
    onLessonLayout(!!session || !!summary)
  }, [session, summary, onLessonLayout])

  if (!course || !p) return <p className="hint">Getting the course ready…</p>

  const now = Date.now()
  const streak = streakNow(p, now)
  const today = xpToday(p, now)
  const due = dueItems(p, now).filter((id) => course.items.has(id))
  // the first unit with lessons still to do
  const at = course.units.findIndex((u) => (p.done[u.id] ?? 0) < lessonsOf(u).length)

  const start = (unit: number) => {
    tap()
    const lesson = p.done[course.units[unit].id] ?? 0
    setSession({ kind: 'lesson', unit, lesson, steps: buildLesson(course, unit, lesson, p, Date.now()) })
  }

  const review = () => {
    tap()
    setSession({ kind: 'review', steps: buildReview(course, p, Date.now()) })
  }

  const finish = (r: LessonResult) => {
    if (!session) return
    const t = Date.now()
    const mem = { ...p.mem }
    for (const [id, right] of r.results) mem[id] = remember(mem[id], right, t)
    let next: Progress = { ...p, mem }
    if (session.kind === 'lesson') {
      const id = course.units[session.unit].id
      next.done = { ...p.done, [id]: Math.max(p.done[id] ?? 0, session.lesson + 1) }
    }
    const earned = xpFor(r.mistakes)
    next = finishSession(next, earned, t)
    save(next)
    setSession(null)
    setSummary({
      kind: session.kind,
      earned,
      score: r.answered ? (r.answered - r.mistakes) / r.answered : 1,
      streak: next.streak.count,
      today: xpToday(next, t),
      goal: next.goal,
    })
    // the signer signs "good"
    const good = course.items.get('good')
    if (good) onPlay([glossOf(good)])
  }

  const leave = () => {
    tap()
    setSession(null)
    setSummary(null)
    onEnd()
  }

  const cycleGoal = () => {
    tap()
    save({ ...p, goal: GOALS[(GOALS.indexOf(p.goal) + 1) % GOALS.length] })
  }

  if (session) {
    return (
      <Lesson steps={session.steps} items={course.items} onPlay={onPlay} onDone={finish} onQuit={leave} top={top}
        onSignAlong={onSignAlong} mirror={mirror} camera={camera} onCamera={chooseCamera} />
    )
  }

  if (summary) {
    const met = summary.today >= summary.goal
    return (
      <section className="lesson-done" aria-labelledby="done-title">
        <div className="done-mark">
          <CheckIcon size={40} />
        </div>
        <h2 id="done-title">{summary.kind === 'lesson' ? 'Lesson complete' : 'Review complete'}</h2>
        <div className="done-stats">
          <div>
            <b>+{summary.earned}</b>
            <span>XP</span>
          </div>
          <div>
            <b>{Math.round(summary.score * 100)}%</b>
            <span>right</span>
          </div>
          <div>
            <b>{summary.streak}</b>
            <span>{summary.streak === 1 ? 'day streak' : 'days in a row'}</span>
          </div>
        </div>
        <p className="hint">
          {met ? 'That’s today’s goal reached.' : `${summary.goal - summary.today} XP to go for today’s goal.`}
        </p>
        <button className="primary" onClick={leave}>
          Continue
        </button>
      </section>
    )
  }

  return (
    <div className="learn">
      <div className="learn-stats">
        <div className={`streak ${streak.count ? 'on' : ''}`}>
          <FlameIcon size={26} />
          <span>
            <b>{streak.count}</b> {streak.count === 1 ? 'day' : 'days'}
          </span>
        </div>
        <button className="goal" onClick={cycleGoal} aria-label={`${today} of ${p.goal} XP today. Change the daily goal`}>
          <span className="goal-text">
            <b>{Math.min(today, p.goal)}</b> of {p.goal} XP today
          </span>
          <span className="goal-bar">
            <span style={{ width: `${Math.min(1, today / p.goal) * 100}%` }} />
          </span>
        </button>
      </div>
      {!streak.doneToday && (
        <p className="learn-nudge">
          {streak.count ? 'One lesson today keeps your streak going.' : 'Finish a lesson to start a streak.'}
        </p>
      )}

      {due.length > 0 && (
        <section className="review" aria-label="Review">
          <p>
            <b>{due.length === 1 ? 'One sign is slipping' : `${due.length} signs are slipping`}</b>
            <span>A quick review brings {due.length === 1 ? 'it' : 'them'} back.</span>
          </p>
          <button className="primary small" onClick={review} disabled={!ready}>
            Review
          </button>
        </section>
      )}

      <ol className="route" aria-label="Course">
        {course.units.map((u, i) => {
          const lessons = lessonsOf(u)
          const done = Math.min(p.done[u.id] ?? 0, lessons.length)
          const state = at === -1 || i < at ? 'done' : i === at ? 'current' : 'locked'
          return (
            <li key={u.id} className={`unit ${state}`}>
              <div className="unit-head">
                <span className="unit-mark" aria-hidden="true">
                  {state === 'done' ? <CheckIcon size={22} /> : state === 'locked' ? <LockIcon size={18} /> : i + 1}
                </span>
                <h2>
                  {u.title}
                  {state !== 'current' && <small>{state === 'done' ? 'Done' : `${u.signs.length} signs`}</small>}
                </h2>
                <span className="unit-ur ur" lang="ur">
                  {u.ur}
                </span>
              </div>
              {state === 'current' && (
                <ol className="unit-lessons">
                  {lessons.map((l, j) => (
                    <li key={j} className={j < done ? 'done' : j === done ? 'next' : ''}>
                      <span className="lesson-dot" aria-hidden="true">
                        {j < done ? <CheckIcon size={16} /> : j + 1}
                      </span>
                      <span className="lesson-words">
                        <span className="sr">Lesson {j + 1}{j < done ? ', done' : ''}: </span>
                        {l.map((id) => course.items.get(id)?.en).join(', ')}
                      </span>
                      {j === done && (
                        <button className="primary small" onClick={() => start(i)} disabled={!ready}>
                          Start
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </li>
          )
        })}
      </ol>
      {at === -1 && <p className="hint">You’ve finished the course. Reviews keep it fresh.</p>}
      <p className="fine">This course is new: a Deaf PSL teacher hasn’t checked the lessons yet.</p>
    </div>
  )
}
