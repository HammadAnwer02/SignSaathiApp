// The course: units of signs in teaching order, and the lessons each unit splits into.
// Signs were picked for being well tracked in the dataset; a few with one hand over or against the other (horse,
// restaurant, time, train) grade lower in index.json, since the covered hand is only partly seen. Everyday basics it
// doesn't have yet (hello, thank you, yes, where, the numbers 2, 3 and 6) join when they are recorded, and the whole
// course wants a Deaf PSL teacher's review.

import type { SignEntry, SignIndex } from '../signs/data'
import { signLabel } from '../text/translate'

export interface Unit {
  id: string
  title: string
  ur: string
  /** sign ids, in teaching order */
  signs: string[]
}

/** the one-handed alphabet, which the translator also spells with */
export const letterId = (ch: string) => `${ch}_single-handed-letter`
const letters = (s: string) => [...s].map(letterId)

export const COURSE: Unit[] = [
  { id: 'first-words', title: 'First words', ur: 'پہلے الفاظ', signs: ['welcome_reception', 'good', 'not', 'name', 'what', 'i_me', 'aap', 'help'] },
  { id: 'letters-a-m', title: 'Fingerspelling A to M', ur: 'حروفِ تہجی', signs: letters('abcdefghijklm') },
  { id: 'family', title: 'Family', ur: 'خاندان', signs: ['mother', 'brother', 'sister', 'son', 'daughter', 'husband', 'wife', 'paternal-grandmother', 'paternal-grandfather'] },
  { id: 'letters-n-z', title: 'Fingerspelling N to Z', ur: 'حروفِ تہجی', signs: letters('nopqrstuvwxyz') },
  { id: 'people', title: 'People', ur: 'لوگ', signs: ['male', 'woman', 'boy', 'girl', 'friend', 'teacher'] },
  { id: 'feelings', title: 'Feelings', ur: 'جذبات', signs: ['happiness', 'anger', 'anxious', 'calm', 'upset', 'worry', 'ill', 'busy'] },
  { id: 'colours', title: 'Colours', ur: 'رنگ', signs: ['color', 'red', 'blue', 'black', 'white', 'yellow', 'pink', 'brown', 'purple'] },
  { id: 'food', title: 'Food and drink', ur: 'کھانا پینا', signs: ['roti', 'rice', 'egg', 'tea', 'juice', 'mango', 'samosa', 'yogurt', 'icecream'] },
  { id: 'time', title: 'Time', ur: 'وقت', signs: ['today', 'tomorrow', 'morning', 'evening', 'night', 'day', 'week', 'month', 'year'] },
  { id: 'places', title: 'Places', ur: 'جگہیں', signs: ['house', 'mosque', 'market', 'shop', 'office', 'city', 'village', 'library', 'restaurant'] },
  { id: 'school', title: 'School', ur: 'اسکول', signs: ['book', 'pen', 'pencil', 'eraser', 'notebook', 'classroom', 'sharpener', 'principal'] },
  { id: 'animals', title: 'Animals', ur: 'جانور', signs: ['cat', 'cow', 'horse', 'lion', 'monkey', 'parrot', 'fish', 'frog', 'giraffe'] },
  { id: 'getting-around', title: 'Getting around', ur: 'سفر', signs: ['car', 'bus', 'rickshaw', 'motorcycle', 'airplane', 'train_vehicle', 'road', 'airport'] },
]

/** Names and short words to fingerspell, offered once every letter in them has been taught. */
export const SPELL_WORDS = [
  'ali', 'dad', 'bad', 'cab', 'bag', 'face', 'fig', 'jam', 'kid', 'milk', 'lake', 'cake', 'bike', 'hiba', 'adil',
  'bilal', 'fahad', 'hamid', 'jamil', 'kamal', 'laila', 'maham', 'amna', 'nadia', 'omar', 'rabia', 'sana', 'tariq',
  'usman', 'zara', 'zaid', 'saima', 'imran', 'huma', 'dua', 'hina', 'sara', 'nida', 'zoya', 'farah', 'kiran', 'noor',
  'iqbal', 'yasir', 'waqar', 'qasim', 'sun', 'tea', 'box', 'zoo', 'quiz', 'yes', 'van', 'web', 'pink', 'red', 'blue',
  'car', 'bus', 'cat', 'cow', 'dog', 'egg', 'home', 'love', 'name', 'jump', 'gift', 'fox',
]

/** A unit's signs split into lessons of three or four. */
export function lessonsOf(unit: Unit): string[][] {
  const n = unit.signs.length
  const count = Math.ceil(n / 4)
  const out: string[][] = []
  let at = 0
  for (let i = 0; i < count; i++) {
    const size = Math.ceil((n - at) / (count - i))
    out.push(unit.signs.slice(at, at + size))
    at += size
  }
  return out
}

/** Something to learn: a sign, or one letter of the alphabet. */
export interface Item {
  id: string
  /** what it means, as shown on an answer */
  en: string
  ur?: string
  letter: boolean
}

export function itemOf(s: SignEntry): Item {
  const l = signLabel(s)
  if (s.kind === 'letter-en') return { id: s.id, en: l.en.toLocaleUpperCase('en'), letter: true }
  return { id: s.id, en: l.en === 'i' ? 'I' : l.en, ur: l.ur, letter: false }
}

/** The course as this copy of the data can teach it: units keep only the signs the index has. */
export function courseFrom(index: SignIndex): { units: Unit[]; items: Map<string, Item> } {
  const byId = new Map(index.signs.map((s) => [s.id, s]))
  const items = new Map<string, Item>()
  const units = COURSE.map((u) => ({ ...u, signs: u.signs.filter((id) => byId.has(id)) })).filter((u) => u.signs.length)
  for (const u of units) for (const id of u.signs) items.set(id, itemOf(byId.get(id)!))
  return { units, items }
}
