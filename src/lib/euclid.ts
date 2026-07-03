/**
 * Euclidean rhythm via the "bucket" formulation of Bjorklund's algorithm.
 * Distributes `pulses` onsets as evenly as possible across `steps` slots.
 */
export function euclid(pulses: number, steps: number): boolean[] {
  if (steps <= 0) return []
  if (pulses <= 0) return new Array(steps).fill(false)
  if (pulses >= steps) return new Array(steps).fill(true)

  const pattern: boolean[] = []
  let bucket = 0
  for (let i = 0; i < steps; i++) {
    bucket += pulses
    if (bucket >= steps) {
      bucket -= steps
      pattern.push(true)
    } else {
      pattern.push(false)
    }
  }
  // rotate so the pattern starts on an onset — a stable anchor point
  const first = pattern.indexOf(true)
  return pattern.slice(first).concat(pattern.slice(0, first))
}

/** Rotate a pattern so different rings anchor to different beats. */
export function rotate<T>(pattern: T[], by: number): T[] {
  const n = pattern.length
  if (n === 0) return pattern
  const k = ((by % n) + n) % n
  return pattern.slice(k).concat(pattern.slice(0, k))
}
