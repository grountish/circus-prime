import * as Tone from 'tone'
import { euclid, rotate } from './euclid'
import { type Ring, FADE_START, ageOf, envelope, makeRing, pulsesAt } from './ring'
import { Tuning, type ScaleName } from './tuning'

const RING_LIFE = 45 // shorter lives — generations turn over without crowding
const SPAWN_EVERY = '1m' // refill an open slot every measure — no dead air
const RETIRE_WITHIN = 12 // seconds old-key rings take to finish after a modulation
const CANON_STEPS = 2 // shadow voice trails the leader by this many steps

// A measure of 4×192 = 768 ticks divides evenly by every grid (4, 6, 8, 12,
// 16) → integer ticks per step, all rings phase-locked to the measure
// forever, through BPM changes included.
const PPQ = 192
const TICKS_PER_MEASURE = PPQ * 4

interface Voice {
  ring: Ring
  loop: Tone.Loop
  synth: Tone.MembraneSynth | Tone.Synth
  /** canon partner — repeats the leader's notes octave-up, a few steps late */
  shadow?: Tone.Synth
  gain: Tone.Gain
}

/**
 * Audio engine. One shared cycle (a 4/4 measure); each ring divides it into
 * an even grid, so layered euclidean patterns interlock as grooves. Melodic
 * cells + trailing canon shadows unfold over a steady eternal pulse —
 * Music-for-18-Musicians logic in orbit form.
 */
export class Engine {
  rings: Ring[] = []
  running = $state(false)
  started = $state(false)
  /** current key + scale label, updated on modulation */
  key = $state('')
  readonly tuning = new Tuning()

  private voices = new Map<number, Voice>()
  private master!: Tone.Gain
  /** post-limiter volume — user level never changes compressor/limiter drive */
  private out?: Tone.Gain
  /** every master-chain node, in order, for teardown */
  private chain: Tone.ToneAudioNode[] = []
  private pulseRing?: Ring
  private droneGain?: Tone.Gain
  private droneOscs: Tone.Oscillator[] = []
  private nextRingId = 0
  private spawnEventId = -1
  private modulateEventId = -1
  /** transport-seconds at the last modulation (or cycle-length change) —
   * phase math can't use `seconds % modulateEvery` once the rate is dynamic */
  private cycleStart = 0
  private disposed = false

  private _bpm = $state(69)
  private _scale: ScaleName | 'auto' = $state('mixolydian')
  private _modulateEvery = $state(60) // seconds between key changes
  private _orbits = $state(9) // melodic rings (the eternal pulse rides on top)
  private _volume = $state(0.8)
  private _dronePeak = $state(0.2) // drone gain at the middle of a key cycle

  constructor() {
    this.tuning.setScale('mixolydian')
    this.key = this.tuning.currentKeyName()
  }

  get bpm(): number {
    return this._bpm
  }

  set bpm(value: number) {
    this._bpm = value
    if (this.started) Tone.getTransport().bpm.value = value
    // ring loop intervals are in ticks — they follow the transport automatically
  }

  get scale(): ScaleName | 'auto' {
    return this._scale
  }

  /** Pin a scale or return to auto-rotation. Drone and pulse sit on the tonic
   * (every scale's first ratio is 1), so only melodic rings retire — the
   * existing ~12 s crossfade covers the switch. */
  set scale(name: ScaleName | 'auto') {
    this._scale = name
    this.tuning.setScale(name)
    this.key = this.tuning.currentKeyName()
    if (name !== 'auto' && this.started) this.retireMelodicRings(Tone.now())
  }

  get modulateEvery(): number {
    return this._modulateEvery
  }

  set modulateEvery(seconds: number) {
    this._modulateEvery = seconds
    if (!this.started) return
    const transport = Tone.getTransport()
    transport.clear(this.modulateEventId)
    this.modulateEventId = transport.scheduleRepeat(
      (time) => this.modulate(time),
      seconds,
      `+${seconds}`,
    )
    // restart the cycle here — drone arc and nebula stay in phase
    this.cycleStart = transport.seconds
    if (this.running) this.scheduleDroneCycle(0, Tone.now())
  }

  get orbits(): number {
    return this._orbits
  }

  /** Target melodic-ring population. Lowering it doesn't kill live rings —
   * they age out naturally (up to ~45 s), by design. */
  set orbits(n: number) {
    this._orbits = Math.round(Math.min(9, Math.max(2, n)))
  }

  get volume(): number {
    return this._volume
  }

  set volume(v: number) {
    this._volume = v
    // squared taper reads as even loudness travel; short ramp — no zipper
    this.out?.gain.rampTo(v * v, 0.08)
  }

  get dronePeak(): number {
    return this._dronePeak
  }

  set dronePeak(v: number) {
    this._dronePeak = v
    if (this.running) this.scheduleDroneCycle(this.cycleOffset(), Tone.now())
  }

  async start(): Promise<void> {
    await Tone.start()
    if (this.disposed) return
    if (!this.started) {
      this.started = true
      // gentle master chain: shave highs, then soft-knee squeeze, then space
      // slow shallow vibrato first — tape-wow pitch drift, the vintage wobble
      const vibrato = new Tone.Vibrato({ frequency: 3.8, depth: 0.14, wet: 1 })
      const softener = new Tone.Filter({ type: 'lowpass', frequency: 4500, rolloff: -12 })
      const compressor = new Tone.Compressor({
        threshold: -24,
        ratio: 4,
        knee: 20, // wide soft knee — compression eases in, never grabs
        attack: 0.005,
        release: 0.25,
      })
      const reverb = new Tone.Reverb({ decay: 6, wet: 0.25 })
      const limiter = new Tone.Limiter(-2) // hard ceiling — coinciding hits can't clip
      // 10-band EQ dialed in by ear: scoop the muddy low-mids (deepest at
      // 128 Hz), leave presence flat, lift the air above 8 kHz
      const EQ_BANDS: Array<[number, number]> = [
        [32, -3.5],
        [64, -5.4],
        [128, -7.8],
        [250, -6.6],
        [500, -5.9],
        [1000, -2.1],
        [8000, 2.8],
        [16000, 4],
      ]
      const eq = EQ_BANDS.map(
        ([frequency, gain], i) =>
          new Tone.BiquadFilter({
            type: i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking',
            frequency,
            Q: 1.4, // octave-band width, matches a 10-band graphic EQ
            gain,
          }),
      )
      this.master = new Tone.Gain(0.7)
      this.out = new Tone.Gain(this._volume ** 2)
      this.master.chain(vibrato, softener, compressor, reverb, ...eq, limiter, this.out, Tone.getDestination())
      this.chain = [this.master, vibrato, softener, compressor, reverb, ...eq, limiter, this.out]
      await reverb.ready
      if (this.disposed) return

      const transport = Tone.getTransport()
      transport.PPQ = PPQ
      transport.bpm.value = this._bpm
      this.startPulse() // the timekeeper lives before anything blooms
      this.startDrone()
      this.spawnRing()
      this.spawnEventId = transport.scheduleRepeat(() => {
        this.reap()
        // rings already withering don't hold a slot — the successor blooms
        // while its predecessor fades, generations overlapping like breaths
        const now = Tone.now()
        const active = this.rings.filter(
          (r) => !r.dead && (r.eternal || ageOf(r, now) < FADE_START),
        ).length
        if (active < this._orbits + 1) this.spawnRing() // +1: the eternal pulse
      }, SPAWN_EVERY)
      // every modulateEvery seconds the tonic climbs a fifth; existing rings
      // keep their pitch and fade out, so the key crossfades over one lifetime
      this.modulateEventId = transport.scheduleRepeat(
        (time) => this.modulate(time),
        this._modulateEvery,
        `+${this._modulateEvery}`,
      )
      this.cycleStart = transport.seconds
    }
    this.resume()
  }

  pause(): void {
    if (!this.started || !this.running) return
    Tone.getTransport().pause()
    // oscillators run free of the transport — silence them explicitly, then
    // stop them once the ramp lands so pause costs zero idle DSP, no click
    const now = Tone.now()
    const g = this.droneGain?.gain
    if (g) {
      g.cancelScheduledValues(now)
      g.rampTo(0, 0.4)
    }
    for (const osc of this.droneOscs) osc.stop(now + 0.5)
    this.running = false
  }

  resume(): void {
    if (!this.started || this.running || this.disposed) return
    // rebuild rather than restart — a pending scheduled stop can't kill a
    // fresh oscillator, and the rebuild picks up the current key for free
    if (this.droneGain) this.buildDroneOscs()
    Tone.getTransport().start()
    // (re)enter the drone's volume arc wherever the transport sits in the cycle
    this.scheduleDroneCycle(this.cycleOffset(), Tone.now())
    this.running = true
  }

  /** Full teardown — the transport and destination are global and survive;
   * everything this engine created dies here. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const transport = Tone.getTransport()
    transport.stop()
    if (this.spawnEventId >= 0) transport.clear(this.spawnEventId)
    if (this.modulateEventId >= 0) transport.clear(this.modulateEventId)
    // sources first, chain after — nothing renders into a disposed node
    for (const voice of this.voices.values()) {
      voice.loop.stop()
      voice.loop.dispose()
      voice.synth.dispose()
      voice.shadow?.dispose()
      voice.gain.dispose()
    }
    this.voices.clear()
    this.rings = []
    this.pulseRing = undefined
    for (const osc of this.droneOscs) osc.dispose()
    this.droneOscs = []
    this.droneGain?.dispose()
    this.droneGain = undefined
    for (const node of this.chain) node.dispose()
    this.chain = []
    this.running = false
    this.started = false
  }

  private modulate(time: number): void {
    const key = this.tuning.modulateFifth()
    if (this.pulseRing) this.pulseRing.freqs = [this.tuning.degreeFreq(0, 1)] // pulse follows the key
    this.retuneDrone(time) // retuned exactly while its volume arc sits at zero
    this.cycleStart = Tone.getTransport().seconds
    this.scheduleDroneCycle(0, time)
    this.retireMelodicRings(time)
    Tone.getDraw().schedule(() => {
      this.key = key
    }, time)
  }

  /** Compress the clocks of live melodic rings: age stays continuous (no
   * level/radius pop) but the rest of each life plays out within
   * RETIRE_WITHIN seconds — short, consonant crossfade into what's next. */
  private retireMelodicRings(time: number): void {
    for (const ring of this.rings) {
      if (ring.eternal || ring.dead || ring.birth < 0) continue
      const a = ageOf(ring, time)
      if (a >= 0.95) continue
      const life = RETIRE_WITHIN / (1 - a)
      ring.birth = time - a * life
      ring.life = life
      ring.retiring = true // freeze the figure — it only fades from here
    }
  }

  /** Seconds into the current key cycle. */
  private cycleOffset(): number {
    const elapsed = Tone.getTransport().seconds - this.cycleStart
    return ((elapsed % this._modulateEvery) + this._modulateEvery) % this._modulateEvery
  }

  /** Root-note drone — swells in after each key change, gone before the next. */
  private startDrone(): void {
    this.droneGain = new Tone.Gain(0).connect(this.master)
    this.buildDroneOscs()
  }

  private buildDroneOscs(): void {
    for (const osc of this.droneOscs) osc.dispose()
    this.droneOscs = [
      new Tone.Oscillator({ frequency: this.tuning.degreeFreq(0, -1), type: 'sine', volume: 0 }),
      new Tone.Oscillator({ frequency: this.tuning.degreeFreq(0, 0), type: 'sine', volume: -8 }),
    ]
    for (const osc of this.droneOscs) {
      osc.connect(this.droneGain!)
      osc.start()
    }
  }

  private retuneDrone(time: number): void {
    this.droneOscs[0]?.frequency.setValueAtTime(this.tuning.degreeFreq(0, -1), time)
    this.droneOscs[1]?.frequency.setValueAtTime(this.tuning.degreeFreq(0, 0), time)
  }

  /**
   * Volume arc over one key cycle: silent at each key change, peaking at the
   * middle — the drone never bleeds into the next key. `offset` is how far
   * into the cycle we already are (0 right after a modulation).
   */
  private scheduleDroneCycle(offset: number, time: number): void {
    if (!this.droneGain) return
    const g = this.droneGain.gain
    const cycle = this._modulateEvery
    const half = cycle / 2
    g.cancelScheduledValues(time)
    g.setValueAtTime(this._dronePeak * Math.sin((Math.PI * offset) / cycle), time)
    if (offset < half) g.linearRampToValueAtTime(this._dronePeak, time + (half - offset))
    g.linearRampToValueAtTime(0, time + (cycle - offset))
  }

  /** Drone swell 0..1 within the current key cycle — mirrored by the nebula. */
  droneLevel(): number {
    if (!this.started || !this.running) return 0
    return Math.sin((Math.PI * this.cycleOffset()) / this._modulateEvery)
  }

  /** The eternal ground pulse — steady eighths on the tonic, innermost orbit. */
  private startPulse(): void {
    const ring: Ring = {
      id: -1,
      steps: 8,
      maxPulses: 8,
      rotation: 0,
      freqs: [this.tuning.degreeFreq(0, 1)],
      noteIndex: 0,
      hue: 46, // warm gold — the timekeeper reads differently from the blooms
      voice: 'mallet',
      birth: -1,
      life: Infinity,
      eternal: true,
      pattern: new Array(8).fill(true),
      step: 0,
      lastHitMs: -1e9,
      dead: false,
    }
    const gain = new Tone.Gain(0.5).connect(this.master)
    const synth = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.018, decay: 0.15, sustain: 0, release: 0.12 },
      volume: -10,
    }).connect(gain)

    const loop = new Tone.Loop((time) => {
      if (ring.birth < 0) ring.birth = time
      const index = ring.step % ring.steps
      ring.step++
      synth.triggerAttackRelease(ring.freqs[0], 0.1, time, index % 4 === 0 ? 0.55 : 0.38)
      Tone.getDraw().schedule(() => {
        ring.lastHitMs = performance.now()
      }, time)
    }, `${TICKS_PER_MEASURE / 8}i`)
    loop.start('@1m')

    this.pulseRing = ring
    this.rings.push(ring)
    this.voices.set(ring.id, { ring, loop, synth, gain })
  }

  private spawnRing(): void {
    const ring = makeRing(RING_LIFE, this.nextRingId++, this.tuning)
    const gain = new Tone.Gain(0).connect(this.master)
    const synth = this.makeSynth(ring.voice).connect(gain)
    // canon shadow for the melodic voices; a low canon would just be mud
    const shadow =
      ring.voice === 'membrane'
        ? undefined
        : new Tone.Synth({
            oscillator: { type: 'sine' },
            envelope: { attack: 0.035, decay: 0.7, sustain: 0, release: 0.6 },
            volume: -12,
          }).connect(gain)

    const loop = new Tone.Loop((time) => {
      if (ring.birth < 0) ring.birth = time // first step IS the measure downbeat
      const age = ageOf(ring, time)
      if (age >= 1) return
      const level = envelope(age)
      const index = ring.step % ring.steps
      ring.step++
      // density only changes on the downbeat — mid-cycle the pattern is frozen;
      // per-ring rotation staggers the anchor beats across the orbits
      if ((index === 0 && !ring.retiring) || ring.pattern.length === 0) {
        ring.pattern = rotate(euclid(pulsesAt(ring, age), ring.steps), ring.rotation)
      }
      // smooth approach instead of a stepped jump — no zipper during fast fades
      gain.gain.setTargetAtTime(level, time, 0.12)
      if (!ring.pattern[index] || level < 0.02) return

      // gentle downbeat accent — enough anchor for the ear without stacking
      // full-velocity hits from every orbit on beat one; narrow velocity
      // range keeps every hit near the average, nothing jumps out
      const accent = index === 0 ? 0.82 : 0.68
      const velocity = (0.5 + 0.35 * level) * accent
      // walk the melodic cell: each onset takes the next note of the figure
      const base = ring.freqs[ring.noteIndex % ring.freqs.length]
      ring.noteIndex++
      // tom folds down an octave unless the cell already sits low — below
      // ~45 Hz the fundamental vanishes on small speakers
      const spread = ring.voice === 'membrane' ? (base < 90 ? 1 : 0.5) : ring.voice === 'mallet' ? 2 : 1
      this.playNote(synth, ring, base * spread, time, velocity)
      if (shadow) {
        // the canon: same note, octave up, trailing by CANON_STEPS — the
        // composite melody lives between leader and shadow
        const stepSeconds = 240 / this._bpm / ring.steps
        this.playNote(shadow, ring, base * spread * 2, time + CANON_STEPS * stepSeconds, velocity * 0.55)
      }
      Tone.getDraw().schedule(() => {
        ring.lastHitMs = performance.now()
      }, time)
    }, `${TICKS_PER_MEASURE / ring.steps}i`)
    loop.start('@1m') // quantize: step 0 lands exactly on a measure boundary

    this.voices.set(ring.id, { ring, loop, synth, shadow, gain })
    this.rings.push(ring)
  }

  private makeSynth(voice: Ring['voice']) {
    switch (voice) {
      case 'membrane':
        // tuned tom / conga — barely any pitch sweep, no "drop"
        return new Tone.MembraneSynth({
          pitchDecay: 0.012,
          octaves: 1.5,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.02, decay: 0.9, sustain: 0, release: 0.4 },
          volume: -5,
        })
      case 'keys':
        // soft sine keys — longer tail than the mallet, fills the mid register
        return new Tone.Synth({
          oscillator: { type: 'sine' },
          envelope: { attack: 0.045, decay: 1.6, sustain: 0, release: 1.2 },
          volume: -5,
        })
      case 'mallet':
        // pure sine music-box / kalimba — zero metallic overtones
        return new Tone.Synth({
          oscillator: { type: 'sine' },
          envelope: { attack: 0.03, decay: 0.9, sustain: 0, release: 0.8 },
          volume: -7,
        })
    }
  }

  private playNote(
    synth: Tone.MembraneSynth | Tone.Synth,
    ring: Ring,
    freq: number,
    time: number,
    velocity: number,
  ): void {
    const breath = this.breath(ring, time)
    if (synth instanceof Tone.MembraneSynth) {
      synth.envelope.decay = 0.3 + 0.8 * breath
      synth.triggerAttackRelease(freq, 0.15 + 0.7 * breath, time, velocity)
    } else if (ring.voice === 'keys') {
      synth.envelope.decay = 0.8 + 1.4 * breath // long singing tail at breath peak
      synth.triggerAttackRelease(freq, 0.3 + 1.0 * breath, time, velocity)
    } else {
      synth.envelope.decay = 0.4 + 1.0 * breath
      synth.triggerAttackRelease(freq, 0.2 + 0.8 * breath, time, velocity)
    }
  }

  /**
   * Slow per-ring sine LFO (0..1) sampled at each trigger — note lengths
   * breathe gently instead of repeating identically. Depth kept shallow so
   * the figure still reads as the same figure every cycle.
   */
  private breath(ring: Ring, time: number): number {
    const rate = 0.06 + (ring.steps % 7) * 0.015 // Hz
    const phase = ring.id * 2.39996
    return 0.5 + 0.3 * Math.sin(2 * Math.PI * rate * time + phase)
  }

  /** Dispose rings that finished their lifespan. */
  private reap(): void {
    const now = Tone.now()
    for (const ring of this.rings) {
      if (!ring.dead && !ring.eternal && ring.birth >= 0 && ageOf(ring, now) >= 1) {
        ring.dead = true
        const voice = this.voices.get(ring.id)
        if (voice) {
          voice.loop.stop()
          voice.loop.dispose()
          voice.synth.dispose()
          voice.shadow?.dispose()
          voice.gain.dispose()
          this.voices.delete(ring.id)
        }
      }
    }
    this.rings = this.rings.filter((r) => !r.dead)
  }

  now(): number {
    return Tone.now()
  }

  /** Phase 0..1 through the shared measure — drives the comet playheads. */
  cyclePhase(): number {
    if (!this.started) return 0
    return (Tone.getTransport().ticks % TICKS_PER_MEASURE) / TICKS_PER_MEASURE
  }
}
