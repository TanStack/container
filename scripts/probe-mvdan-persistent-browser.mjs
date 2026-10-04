import assert from 'node:assert/strict'
import { chromium, firefox, webkit } from 'playwright'

const origin = process.env.NATIVE_OWNER_ORIGIN ?? 'http://127.0.0.1:4247'
for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(origin + '/owner.html')
    const result = await page.evaluate(async ownerOrigin => {
      const worker = new Worker('/runtime/workers/mvdan-shell.js', { type: 'module' })
      let ready
      const initialized = new Promise((resolve, reject) => {
        ready = { resolve, reject }
      })
      let current
      worker.onerror = event => { ready.reject(Error(event.message)); current?.reject(Error(event.message)) }
      worker.onmessage = ({ data }) => {
        if (data.ready) { ready.resolve(); return }
        if (data.id !== undefined) {
          let value
          if (data.method === 'stat' || data.method === 'lstat') value = { kind: 'directory', size: 0, mode: 0o755 }
          else if (data.method === 'stdio.stdout' || data.method === 'stdio.stderr') {
            const text = new TextDecoder().decode(data.args[0])
            current[data.method === 'stdio.stdout' ? 'stdout' : 'stderr'] += text
          } else if (data.method === 'stdio.read') value = null
          else { current?.reject(Error('Unexpected shell request: ' + data.method)); return }
          worker.postMessage({ reply: data.id, value })
          return
        }
        if (data.error) { current?.reject(Error(data.error)); return }
        if (data.result) { current?.resolve({ ...data.result, stdout: current.stdout, stderr: current.stderr }); current = undefined }
      }
      worker.postMessage({ init: true, assetBaseURL: ownerOrigin + '/runtime/' })
      try {
        await initialized
        const run = script => new Promise((resolve, reject) => {
          current = { resolve, reject, stdout: '', stderr: '' }
          worker.postMessage({ run: true, persistent: true, streaming: true, script, cwd: '/project', env: {}, timeoutMs: 0 })
        })
        const setup = await run("shopt -s expand_aliases; alias greet='printf alias-'; local_value=kept; function finish { printf function; }")
        const state = await run('greet; finish; printf ":%s\\n" "$local_value"')
        const option = await run('set -o pipefail')
        const failedPipeline = await run('false | true')
        const cleanup = await run('unalias greet; unset -f finish; unset local_value')
        const after = await run('printf "%s\\n" "$local_value"')
        return { setup, state, option, failedPipeline, cleanup, after }
      } finally { worker.terminate() }
    }, origin)
    console.log(name, JSON.stringify({ state: result.state.stdout, pipeline: result.failedPipeline.code, after: result.after.stdout }))
    assert.equal(result.setup.code, 0)
    assert.equal(result.state.stdout, 'alias-function:kept\n')
    assert.equal(result.failedPipeline.code, 1)
    assert.equal(result.cleanup.code, 0)
    assert.equal(result.after.stdout, '\n')
  } finally { await browser.close() }
}
