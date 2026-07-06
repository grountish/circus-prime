import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// on-device error console for phones: open with ?debug in the URL
if (new URLSearchParams(location.search).has('debug')) {
  const box = document.createElement('div')
  box.style.cssText =
    'position:fixed;top:0;left:0;right:0;max-height:45vh;overflow:auto;z-index:9999;' +
    'background:rgba(0,0,0,0.85);color:#f66;font:11px/1.4 monospace;padding:6px;white-space:pre-wrap'
  document.body.appendChild(box)
  const log = (msg: string) => (box.textContent += msg + '\n')
  window.addEventListener('error', (e) => log(`${e.message} @ ${e.filename}:${e.lineno}`))
  window.addEventListener('unhandledrejection', (e) => log(`unhandled: ${e.reason}`))
  log('debug overlay armed')
}

mount(App, {
  target: document.getElementById('app')!,
})
