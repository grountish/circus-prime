import { ringHue, type Tuning } from './tuning'

export interface Ring {
  id: number
  steps: number // subdivision of the shared cycle
  maxPulses: number
  /** pattern rotation — spreads each ring's onsets to a different anchor beat,
   * so the downbeat doesn't collect a hit from every orbit at once */
  rotation: number
  /** melodic cell — successive onsets walk this loop of frequencies, so the
   * ring repeats an exact little figure instead of one pitch */
  freqs: number[]
  noteIndex: number
  hue: number
  voice: 'membrane' | 'keys' | 'mallet'
  birth: number // seconds, audio-context clock; -1 until first quantized step fires
  life: number // seconds
  /** the ground-pulse orbit: never ages, never dies */
  eternal?: boolean
  /** set at key change — the figure freezes and only fades from here */
  retiring?: boolean
  /** active pattern — recomputed only at cycle boundaries so onsets never shift mid-measure */
  pattern: boolean[]
  /** viz state, written from audio callbacks via Tone.Draw */
  step: number
  lastHitMs: number
  dead: boolean
}

/** Normalized age 0..1 over the ring's lifespan. */
export function ageOf(ring: Ring, now: number): number {
  if (ring.birth < 0 || ring.eternal) return 0
  return (now - ring.birth) / ring.life
}

/** Age at which the wither begins — spawning stops waiting for rings past this. */
export const FADE_START = 0.62

/**
 * Shared loudness/opacity envelope: bloom in, hold, wither out.
 *   0.00–0.18 fade in · 0.18–FADE_START full · FADE_START–1.00 fade out
 */
export function envelope(age: number): number {
  if (age <= 0) return 0
  if (age < 0.18) return age / 0.18
  if (age < FADE_START) return 1
  if (age < 1) return 1 - (age - FADE_START) / (1 - FADE_START)
  return 0
}

/**
 * Pulses grow with age, plateauing early: a short bloom, then a long stable
 * stretch where the figure repeats unchanged — change as event, not weather.
 */
export function pulsesAt(ring: Ring, age: number): number {
  const t = Math.min(Math.max(age, 0) / 0.35, 1)
  return 1 + Math.floor(t * (ring.maxPulses - 1))
}

/**
 * Grids per voice — every grid divides the measure evenly, so layers lock
 * into grooves (E(3,8) tresillo, E(5,16)…). The 6/12 keys add a gentle
 * 3-against-2 hemiola rather than free polyrhythm.
 */
const GRIDS = {
  membrane: [4, 8],
  keys: [6, 12],
  mallet: [8, 16],
} as const

/**
 * Melodic contours as scale-degree offsets — short arpeggiated figures in the
 * Music-for-18 mold. A ring walks its contour on every onset, forever.
 */
const CONTOURS = [
  [0, 2, 4, 2], // rock up and back
  [0, 1, 3, 1], // narrow weave
  [4, 2, 0, 2], // descend and lift
  [0, 3, 2, 5], // open leap
  [2, 0, 4, 3], // pivot around the third
]

export function makeRing(life: number, id: number, tuning: Tuning): Ring {
  const voices = ['membrane', 'keys', 'mallet'] as const
  const voice = voices[id % voices.length]
  const steps = GRIDS[voice][Math.floor(id / voices.length) % 2]
  const contour = CONTOURS[id % CONTOURS.length]
  const baseDegree = (id * 2) % 5 // stagger where each figure sits in the scale
  // latin-square rotation: every consecutive trio of rings covers all three
  // octave tiers AND all three voices, so the full range is always sounding
  const tier = [0, -1, 1][(id + Math.floor(id / 3)) % 3]
  return {
    id,
    steps,
    // sparse cap: dense rings read as noise, not rhythm
    maxPulses: Math.min(5, Math.max(2, Math.ceil(steps * 0.45))),
    rotation: (id * 3) % steps,
    // freeze the cell at spawn — key changes only reach newborn rings
    freqs: contour.map((d) => tuning.degreeFreq(baseDegree + d, tier)),
    noteIndex: 0,
    hue: ringHue(id),
    voice,
    birth: -1,
    life,
    pattern: [],
    step: 0,
    lastHitMs: -1e9,
    dead: false,
  }
}
