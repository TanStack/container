import {runProbe} from './run.mjs'
self.onmessage = async ({data}) => {
  try {
    const base = '/wasm-interpreter-probe' + (data.ubsan ? '-ubsan' : '') + '/'
    const url = new URL(base + 'engine.mjs', self.location.origin).href
    const {default: createEngine} = await import(/* @vite-ignore */ url)
    const engine = await createEngine()
    const report = await runProbe(engine, async name => {
      const response = await fetch(base + name)
      if (!response.ok) throw Error(`Fixture fetch ${name}: ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    }, row => self.postMessage({type: 'progress', row}))
    self.postMessage({type: 'complete', report})
  } catch (error) { self.postMessage({type: 'error', error: String(error.stack || error)}) }
}
