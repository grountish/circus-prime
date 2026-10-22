<script lang="ts">
  import { onMount } from 'svelte'
  import type { Engine } from './engine.svelte'
  import { ageOf, envelope } from './ring'

  let { engine }: { engine: Engine } = $props()

  let canvas: HTMLCanvasElement
  const reducedMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  // Render at native device resolution, capped at 1.5× — on a glow piece the
  // step to 2× is barely visible but fills ~78% more pixels every frame.
  const MAX_DPR = 1.5

  // Pre-rendered radial-gradient sprites replace shadowBlur — the single
  // biggest canvas cost. One drawImage per glow instead of a blur pass.
  const glowCache = new Map<string, HTMLCanvasElement>()
  function glowSprite(hue: number): HTMLCanvasElement {
    const key = `${Math.round(hue / 4) * 4}`
    let sprite = glowCache.get(key)
    if (!sprite) {
      const SIZE = 64
      sprite = document.createElement('canvas')
      sprite.width = sprite.height = SIZE
      const g = sprite.getContext('2d')!
      const grad = g.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2)
      grad.addColorStop(0, `hsl(${hue} 85% 75% / 0.9)`)
      grad.addColorStop(0.3, `hsl(${hue} 85% 60% / 0.32)`)
      grad.addColorStop(1, 'hsl(0 0% 0% / 0)')
      g.fillStyle = grad
      g.fillRect(0, 0, SIZE, SIZE)
      glowCache.set(key, sprite)
    }
    return sprite
  }

  onMount(() => {
    // opaque context — the page behind is the same #0b0714, so the compositor
    // can skip alpha-blending a fullscreen layer every vsync
    const ctx = canvas.getContext('2d', { alpha: false })!
    let raf = 0
    let w = 0
    let h = 0
    let dpr = 1
    let lastFrame = 0
    let nebula: CanvasGradient | null = null
    // bounding box of the nebula gradient — outside it every pixel is
    // transparent, so filling the whole canvas would be wasted rasterization
    let nebX = 0
    let nebY = 0
    let nebW = 0
    let nebH = 0

    const resize = () => {
      w = canvas.clientWidth
      h = canvas.clientHeight
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      // transform maps CSS-pixel coordinates onto the device-pixel bitmap,
      // so every draw below stays in CSS units and renders razor-sharp
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const maxR = Math.min(w, h) * 0.46
      const nebR = maxR * 1.25
      nebX = Math.max(0, w / 2 - nebR)
      nebY = Math.max(0, h / 2 - nebR)
      nebW = Math.min(w, w / 2 + nebR) - nebX
      nebH = Math.min(h, h / 2 + nebR) - nebY
      nebula = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, nebR)
      nebula.addColorStop(0, 'rgba(96, 70, 160, 0.05)')
      nebula.addColorStop(0.55, 'rgba(56, 40, 110, 0.03)')
      nebula.addColorStop(1, 'rgba(0, 0, 0, 0)')
      // an opaque canvas resets to black on resize — prime it with the night
      // color so there's no flash before the first trail fill
      ctx.fillStyle = '#0b0714'
      ctx.fillRect(0, 0, w, h)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const nowMs = performance.now()
      if (nowMs - lastFrame < 15) return // cap ~60 fps on high-refresh displays
      // carry the remainder — snapping to the vsync tick would quantize 90 Hz
      // displays down to 45 fps (and 144 Hz to 48), stretching the trails
      lastFrame = nowMs - ((nowMs - lastFrame) % 15)
      // catch monitor moves / zoom — ResizeObserver misses pure-DPR changes
      if (Math.min(window.devicePixelRatio || 1, MAX_DPR) !== dpr) resize()

      const cx = w / 2
      const cy = h / 2
      const maxR = Math.min(w, h) * 0.46
      const now = engine.now()
      const phase = engine.cyclePhase()

      // low-alpha fill instead of clear → phosphor trails; fast enough that
      // additive light can't pile up and wash the canvas out
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = 'rgba(11, 7, 20, 0.22)'
      ctx.fillRect(0, 0, w, h)

      // faint violet nebula breathing at the center (gradient cached on
      // resize); its brightness rides the drone's swell — the drone IS the
      // nebula's sound
      if (nebula) {
        const breathe = reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(nowMs / 9000)
        ctx.globalAlpha = Math.min(1, breathe * (0.55 + 0.8 * engine.droneLevel()))
        ctx.fillStyle = nebula
        ctx.fillRect(nebX, nebY, nebW, nebH)
        ctx.globalAlpha = 1
      }

      // orbits paint with additive light — overlaps bloom instead of occlude
      ctx.globalCompositeOperation = 'lighter'

      for (const ring of engine.rings) {
        const age = ageOf(ring, now)
        if (!ring.eternal && (age < 0 || age >= 1)) continue
        const pattern = ring.pattern // audio's own pattern — viz never disagrees with ear
        if (pattern.length === 0) continue
        // the eternal pulse sits small and steady at the center of the garden
        const alpha = ring.eternal ? 0.28 : envelope(age)
        const radius = ring.eternal ? 26 : 14 + (maxR - 14) * age
        // counted in place — .filter() here would allocate per ring per frame
        let pulses = 0
        for (let i = 0; i < pattern.length; i++) if (pattern[i]) pulses++
        if (pulses < 1) pulses = 1
        const flash = Math.exp(-(nowMs - ring.lastHitMs) / 260)
        const spin = reducedMotion ? 0 : (nowMs / 60000) * (ring.id % 2 ? 1 : -1)
        const sprite = glowSprite(ring.hue)

        // rose curve: rhodonea r(θ) = R·cos(kθ), petal count follows the pulse
        // count; glow faked with a wide faint understroke — no shadowBlur
        ctx.beginPath()
        for (let t = 0; t <= Math.PI * 2 + 0.03; t += 0.03) {
          const rr = radius * Math.cos(pulses * t)
          const x = cx + rr * Math.cos(t + spin)
          const y = cy + rr * Math.sin(t + spin)
          t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        }
        if (alpha > 0.15) {
          // wide understroke only while the ring is bright enough to matter
          ctx.strokeStyle = `hsl(${ring.hue} 80% 60% / ${alpha * (0.05 + 0.1 * flash)})`
          ctx.lineWidth = 4
          ctx.stroke()
        }
        ctx.strokeStyle = `hsl(${ring.hue} 75% 60% / ${alpha * (0.1 + 0.25 * flash)})`
        ctx.lineWidth = 1 + flash
        ctx.stroke()

        // boundary circle the petals live inside
        ctx.beginPath()
        ctx.arc(cx, cy, radius, 0, Math.PI * 2)
        ctx.strokeStyle = `hsl(${ring.hue} 60% 70% / ${alpha * 0.1})`
        ctx.lineWidth = 1
        ctx.stroke()

        // step dots: rests batched into one flat path, onsets get a sprite glow
        const current = (ring.step - 1 + ring.steps) % ring.steps
        ctx.beginPath()
        for (let i = 0; i < ring.steps; i++) {
          if (pattern[i]) continue
          const angle = -Math.PI / 2 + (i / ring.steps) * Math.PI * 2 + spin
          const x = cx + radius * Math.cos(angle)
          const y = cy + radius * Math.sin(angle)
          ctx.moveTo(x + 1.2, y)
          ctx.arc(x, y, 1.2, 0, Math.PI * 2)
        }
        ctx.fillStyle = `hsl(${ring.hue} 40% 60% / ${alpha * 0.2})`
        ctx.fill()

        // both dot styles are constant for the ring — build them once, not
        // once per onset (fresh color strings are a CSS parse each)
        const dotCurrent = `hsl(${ring.hue} 80% 74% / ${alpha * 0.85})`
        const dotRest = `hsl(${ring.hue} 80% 58% / ${alpha * 0.55})`
        for (let i = 0; i < ring.steps; i++) {
          if (!pattern[i]) continue
          const angle = -Math.PI / 2 + (i / ring.steps) * Math.PI * 2 + spin
          const x = cx + radius * Math.cos(angle)
          const y = cy + radius * Math.sin(angle)
          const isCurrent = i === current
          const size = isCurrent ? 4 + 3 * flash : 2.8
          const glowR = isCurrent ? size * 4 : size * 2.6
          ctx.globalAlpha = alpha * (isCurrent ? 0.9 : 0.5)
          ctx.drawImage(sprite, x - glowR, y - glowR, glowR * 2, glowR * 2)
          ctx.globalAlpha = 1
          ctx.beginPath()
          ctx.arc(x, y, size, 0, Math.PI * 2)
          ctx.fillStyle = isCurrent ? dotCurrent : dotRest
          ctx.fill()
        }

        // comet playhead — sweeps the orbit once per measure, tapering tail
        const head = -Math.PI / 2 + phase * Math.PI * 2 + spin
        const TAIL_SEGS = 12
        const tailSpan = 0.7 // radians of arc behind the head
        // one color for the whole tail; per-segment fade rides globalAlpha —
        // same composite, without 12 fresh color strings per ring per frame
        ctx.strokeStyle = `hsl(${ring.hue} 80% 66% / ${alpha * 0.2})`
        for (let i = 0; i < TAIL_SEGS; i++) {
          const f = i / TAIL_SEGS
          const a0 = head - tailSpan * f
          const a1 = head - tailSpan * (f + 1 / TAIL_SEGS)
          const fade = (1 - f) ** 2
          ctx.beginPath()
          ctx.arc(cx, cy, radius, a1, a0)
          ctx.globalAlpha = fade
          ctx.lineWidth = 2 * fade + 0.3
          ctx.stroke()
        }
        ctx.globalAlpha = 1
        const hx = cx + radius * Math.cos(head)
        const hy = cy + radius * Math.sin(head)
        ctx.globalAlpha = alpha * 0.7
        ctx.drawImage(sprite, hx - 7, hy - 7, 14, 14)
        ctx.globalAlpha = 1
        ctx.beginPath()
        ctx.arc(hx, hy, 2, 0, Math.PI * 2)
        ctx.fillStyle = `hsl(${ring.hue} 55% 82% / ${alpha * 0.65})`
        ctx.fill()
      }

      ctx.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  })
</script>

<canvas bind:this={canvas}></canvas>

<style>
  canvas {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
