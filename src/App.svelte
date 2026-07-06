<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Engine } from './lib/engine.svelte'
  import { Tuning } from './lib/tuning'
  import Visualizer from './lib/Visualizer.svelte'

  const engine = new Engine()
  let begun = $state(false)
  let showPanel = $state(false)

  async function begin() {
    // silent looping <audio> promotes the iOS audio session to "playback",
    // so sound survives the ringer/silent switch
    const unlock = new Audio(
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='
    )
    unlock.loop = true
    unlock.setAttribute('playsinline', '')
    unlock.play().catch(() => {})
    await engine.start()
    begun = true
  }

  // mobile browsers suspend the AudioContext on tab-switch/screen-lock and
  // (on iOS) never resume it themselves
  function onVisible() {
    if (!document.hidden) engine.resumeContext()
  }
  document.addEventListener('visibilitychange', onVisible)

  function toggle() {
    if (engine.running) engine.pause()
    else engine.resume()
  }

  onDestroy(() => {
    document.removeEventListener('visibilitychange', onVisible)
    engine.dispose()
  })
</script>

<main>
  <Visualizer {engine} />

  {#if !begun}
    <button class="begin" onclick={begin}>begin</button>
  {:else}
    {#if showPanel}
      <div class="panel">
        <label class="scale">
          <span>scale</span>
          <select bind:value={engine.scale}>
            <option value="auto">auto</option>
            {#each Tuning.SCALE_NAMES as name}
              <option value={name}>{name}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>{engine.modulateEvery}s cycle</span>
          <input type="range" min="30" max="120" step="5" bind:value={engine.modulateEvery} />
        </label>
        <label>
          <span>{engine.orbits} orbits</span>
          <input type="range" min="2" max="9" step="1" bind:value={engine.orbits} />
        </label>
        <label>
          <span>volume</span>
          <input type="range" min="0" max="1" step="0.01" bind:value={engine.volume} />
        </label>
        <label>
          <span>drone</span>
          <input type="range" min="0" max="0.4" step="0.01" bind:value={engine.dronePeak} />
        </label>
      </div>
    {/if}
    <footer>
      <button class="transport" onclick={toggle}>
        {engine.running ? 'pause' : 'resume'}
      </button>
      <span class="key">{engine.key}</span>
      <label>
        <span>{engine.bpm} bpm</span>
        <input type="range" min="50" max="140" step="1" bind:value={engine.bpm} />
      </label>
      <button class="transport tune" onclick={() => (showPanel = !showPanel)}>
        {showPanel ? 'close' : 'tune'}
      </button>
    </footer>
  {/if}
  <div class="grain" aria-hidden="true"></div>
</main>

<style>
  main {
    position: fixed;
    inset: 0;
  }

  .grain {
    position: fixed;
    inset: -50%;
    pointer-events: none;
    z-index: 30;
    opacity: 0.12;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='1' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  4 4 4 0 -7'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size: 140px 140px;
    animation: grain-jitter 0.7s steps(1) infinite;
  }

  @keyframes grain-jitter {
    0% {
      transform: translate(0, 0);
    }
    12.5% {
      transform: translate(-2%, -3%);
    }
    25% {
      transform: translate(3%, -1%);
    }
    37.5% {
      transform: translate(-1%, 2%);
    }
    50% {
      transform: translate(2%, 3%);
    }
    62.5% {
      transform: translate(-3%, 1%);
    }
    75% {
      transform: translate(1%, -2%);
    }
    87.5% {
      transform: translate(-2%, 3%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .grain {
      animation: none;
    }
  }

  .begin {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-family: var(--mono);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.35em;
    text-indent: 0.35em;
    color: var(--moon);
    background: transparent;
    border: 1px solid color-mix(in oklab, var(--moon) 35%, transparent);
    border-radius: 999px;
    padding: 1.1rem 2.4rem;
    cursor: pointer;
    transition: border-color 0.4s, box-shadow 0.4s;
  }

  .begin:hover,
  .begin:focus-visible {
    border-color: var(--moon);
    box-shadow: 0 0 32px rgba(242, 234, 217, 0.15);
  }

  footer,
  .panel {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding: 0.6rem 1.2rem;
    border-radius: 999px;
    background: rgba(11, 7, 20, 0.55);
    border: 1px solid rgba(242, 234, 217, 0.12);
    backdrop-filter: blur(8px);
  }

  footer {
    bottom: 1.5rem;
  }

  .panel {
    bottom: 4.6rem;
    gap: 1.1rem;
  }

  .transport {
    font-family: var(--mono);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: var(--moon);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.3rem 0;
    min-width: 4.5rem;
    text-align: left;
  }

  .tune {
    min-width: 3rem;
    text-align: right;
    color: var(--haze);
  }

  .key {
    font-family: var(--mono);
    font-size: 0.7rem;
    letter-spacing: 0.2em;
    color: var(--haze);
    min-width: 2ch;
    text-align: center;
  }

  label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-family: var(--mono);
    font-size: 0.7rem;
    letter-spacing: 0.12em;
    color: var(--haze);
  }

  label span {
    min-width: 4.2rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .panel label span {
    min-width: auto;
  }

  .panel input[type='range'] {
    width: 6.5rem;
  }

  input[type='range'] {
    width: 9rem;
    accent-color: var(--moon);
  }

  select {
    font-family: var(--mono);
    font-size: 0.7rem;
    letter-spacing: 0.12em;
    text-transform: lowercase;
    color: var(--moon);
    background: transparent;
    border: none;
    border-bottom: 1px solid rgba(242, 234, 217, 0.12);
    padding: 0.2rem 1.1rem 0.2rem 0.2rem;
    appearance: none;
    cursor: pointer;
  }

  .scale {
    position: relative;
  }

  .scale::after {
    content: '▾';
    position: absolute;
    right: 0.15rem;
    color: var(--haze);
    font-size: 0.6rem;
    pointer-events: none;
  }

  select option {
    background: var(--night, #0b0714);
    color: var(--moon);
  }

  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 1px solid var(--moon);
    outline-offset: 3px;
  }

  @media (max-width: 600px) {
    footer {
      flex-wrap: wrap;
      justify-content: center;
      row-gap: 0.7rem;
      width: calc(100vw - 2rem);
      border-radius: 1.2rem;
      bottom: 1rem;
    }

    /* panel moves to top as a column — wrapped footer height is unpredictable */
    .panel {
      flex-direction: column;
      align-items: stretch;
      top: 1rem;
      bottom: auto;
      width: calc(100vw - 2rem);
      border-radius: 1.2rem;
    }

    .panel label {
      justify-content: space-between;
    }

    .panel input[type='range'] {
      width: 55vw;
    }

    /* Apple 44px tap-target floor */
    .transport {
      min-height: 44px;
      text-align: center;
    }

    input[type='range'] {
      min-height: 32px;
    }

    select {
      min-height: 36px;
    }
  }
</style>
