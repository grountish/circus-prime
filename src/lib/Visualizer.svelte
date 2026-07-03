<script lang="ts">
  import { onMount } from 'svelte'
  import type { Engine } from './engine.svelte'
  import { ageOf, envelope } from './ring'

  let { engine }: { engine: Engine } = $props()

  let canvas: HTMLCanvasElement
  const reducedMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  // The whole scene renders into a reduced-resolution buffer, then blits up
  // to the screen in one GPU-cheap drawImage. 0.9 keeps lines defined while
  // still rasterizing ~64% fewer pixels than rendering at 1.5× DPR.
  const RES = 0.9

  // Pre-rendered radial-gradient sprites replace shadowBlur — the single
  // biggest canvas cost. One drawImage per glow instead of a blur pass.
  const glowCache = new Map<string, HTMLCanvasElement>()
  function glowSprite(hue: number): HTMLCanvasElement {
    const key = `${Math.round(hue / 4) * 4}`
    let sprite = glowCache.get(key)
    if (!sprite) {
      const SIZE = 32
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
    const screen = canvas.getContext('2d')!
    const buffer = document.createElement('canvas')
    const ctx = buffer.getContext('2d')!
    let raf = 0
    let w = 0
    let h = 0
    let lastFrame = 0
    let nebula: CanvasGradient | null = null

    const resize = () => {
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = w
      canvas.height = h
      buffer.width = Math.max(1, Math.round(w * RES))
      buffer.height = Math.max(1, Math.round(h * RES))
      // buffer transform maps CSS-pixel coordinates onto the small bitmap
      ctx.setTransform(RES, 0, 0, RES, 0, 0)
      screen.globalCompositeOperation = 'copy' // blit replaces — no clear needed
      screen.imageSmoothingEnabled = true
      screen.imageSmoothingQuality = 'high'
      const maxR = Math.min(w, h) * 0.46
      nebula = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, maxR * 1.25)
      nebula.addColorStop(0, 'rgba(96, 70, 160, 0.05)')
      nebula.addColorStop(0.55, 'rgba(56, 40, 110, 0.03)')
      nebula.addColorStop(1, 'rgba(0, 0, 0, 0)')
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const nowMs = performance.now()
      if (nowMs - lastFrame < 15) return // cap ~60 fps on high-refresh displays
      lastFrame = nowMs

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
        ctx.fillRect(0, 0, w, h)
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
        const pulses = Math.max(1, pattern.filter(Boolean).length)
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
          ctx.fillStyle = `hsl(${ring.hue} 80% ${isCurrent ? 74 : 58}% / ${alpha * (isCurrent ? 0.85 : 0.55)})`
          ctx.fill()
        }

        // comet playhead — sweeps the orbit once per measure, tapering tail
        const head = -Math.PI / 2 + phase * Math.PI * 2 + spin
        const TAIL_SEGS = 12
        const tailSpan = 0.7 // radians of arc behind the head
        for (let i = 0; i < TAIL_SEGS; i++) {
          const f = i / TAIL_SEGS
          const a0 = head - tailSpan * f
          const a1 = head - tailSpan * (f + 1 / TAIL_SEGS)
          const fade = (1 - f) ** 2
          ctx.beginPath()
          ctx.arc(cx, cy, radius, a1, a0)
          ctx.strokeStyle = `hsl(${ring.hue} 80% 66% / ${alpha * 0.2 * fade})`
          ctx.lineWidth = 2 * fade + 0.3
          ctx.stroke()
        }
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

      // one upscaled blit to the screen — 'copy' replaces the whole frame
      screen.drawImage(buffer, 0, 0, w, h)
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
