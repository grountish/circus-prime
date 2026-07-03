const BASE_FREQ = 110 // A2

/**
 * Just-intonation scales, richer than pentatonic. Dorian is the Reich home
 * color; hirajoshi brings the exotic tension; aeolian the darker minor.
 */
const SCALES = [
  { name: 'dorian', ratios: [1, 9 / 8, 6 / 5, 4 / 3, 3 / 2, 5 / 3, 9 / 5] },
  { name: 'hirajoshi', ratios: [1, 9 / 8, 6 / 5, 3 / 2, 8 / 5] },
  { name: 'aeolian', ratios: [1, 9 / 8, 6 / 5, 4 / 3, 3 / 2, 8 / 5, 9 / 5] },
  { name: 'mixolydian', ratios: [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 16 / 9] },
  { name: 'lydian', ratios: [1, 9 / 8, 5 / 4, 45 / 32, 3 / 2, 5 / 3, 15 / 8] },
  { name: 'phrygian', ratios: [1, 16 / 15, 6 / 5, 4 / 3, 3 / 2, 8 / 5, 9 / 5] },
  { name: 'in-sen', ratios: [1, 16 / 15, 4 / 3, 3 / 2, 9 / 5] },
  { name: 'pent-minor', ratios: [1, 6 / 5, 4 / 3, 3 / 2, 9 / 5] },
] as const

export type ScaleName = (typeof SCALES)[number]['name']

/** Key names around the circle of fifths, starting from A. */
const KEY_NAMES = ['A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯', 'F', 'C', 'G', 'D']

/**
 * Pitch state for one engine: tonic, position on the circle of fifths, and
 * the active scale. Instance state (not module state) so an engine owns its
 * key and two engines can't fight over one tonic.
 */
export class Tuning {
  static readonly SCALE_NAMES: readonly ScaleName[] = SCALES.map((s) => s.name)

  private tonic = BASE_FREQ
  private fifths = 0
  private modulations = 0
  private scaleIndex = 0
  /** user pinned a scale — modulateFifth() must not rotate it away */
  private scaleLocked = false

  constructor() {
    // every session opens somewhere fresh on the wheel — random key, random scale
    this.fifths = Math.floor(Math.random() * KEY_NAMES.length)
    this.scaleIndex = Math.floor(Math.random() * SCALES.length)
    for (let i = 0; i < this.fifths; i++) {
      this.tonic *= 1.5
      while (this.tonic >= BASE_FREQ * 2) this.tonic /= 2
    }
  }

  /**
   * Move the tonic one step around the circle of fifths, folded back into the
   * base octave; every 4th modulation also turns the scale wheel. After a full
   * circle the tonic resets exactly, so the Pythagorean comma never accumulates.
   */
  modulateFifth(): string {
    this.modulations++
    this.fifths = (this.fifths + 1) % KEY_NAMES.length
    if (this.fifths === 0) {
      this.tonic = BASE_FREQ
    } else {
      this.tonic *= 1.5
      while (this.tonic >= BASE_FREQ * 2) this.tonic /= 2
    }
    if (!this.scaleLocked && this.modulations % 4 === 0) {
      this.scaleIndex = (this.scaleIndex + 1) % SCALES.length
    }
    return this.currentKeyName()
  }

  currentKeyName(): string {
    return `${KEY_NAMES[this.fifths]} ${SCALES[this.scaleIndex].name}`
  }

  get scaleName(): ScaleName {
    return SCALES[this.scaleIndex].name
  }

  /** Pin a scale (survives modulations) or 'auto' to resume rotation. */
  setScale(name: ScaleName | 'auto'): void {
    if (name === 'auto') {
      this.scaleLocked = false
      return
    }
    this.scaleLocked = true
    this.scaleIndex = SCALES.findIndex((s) => s.name === name)
  }

  /**
   * Frequency of a scale degree in the current key. Degrees beyond the scale
   * length wrap upward into the next octave; `octave` shifts the whole result.
   */
  degreeFreq(degree: number, octave = 0): number {
    const ratios = SCALES[this.scaleIndex].ratios
    const n = ratios.length
    const oct = Math.floor(degree / n) + octave
    const idx = ((degree % n) + n) % n
    return this.tonic * ratios[idx] * 2 ** oct
  }
}

/** Golden-angle hue rotation — maximally spread colors, never repeats visually. */
export function ringHue(n: number): number {
  return (n * 137.508) % 360
}
