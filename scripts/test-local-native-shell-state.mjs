import assert from 'node:assert/strict'
import { chromium, firefox, webkit } from 'playwright'

const site = process.env.NATIVE_SITE_ORIGIN ?? 'http://127.0.0.1:4228'
const owner = process.env.NATIVE_OWNER_ORIGIN ?? 'http://127.0.0.1:4227'

for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const ownerFrame = page.waitForEvent('framenavigated', {
      predicate: frame => frame.url().startsWith(owner + '/owner.html'),
      timeout: 60000,
    })
    await page.goto(site + '/start/latest/docs/framework/react/examples/start-counter?panel=playground')
    const frame = await ownerFrame
    const result = await frame.evaluate(async () => {
      const { NativeDevServer } = await import('/sdk/index.js')
      const server = new NativeDevServer({
        '/app/index.mjs': 'export default {fetch(){return new Response("ready")}}',
      }, { workerURL: '/runtime/native/engine.js', entry: '/app/index.mjs', serveFetchEntry: true })
      try {
        await server.ready
        const first = await server.terminalCommand('LOCAL=first; export EXPORTED=parent')
        const second = await server.terminalCommand('printf "%s:%s\\n" "$LOCAL" "$EXPORTED"; node -e "console.log(process.env.EXPORTED)"', '/app', undefined, undefined, undefined, first.shellState)
        const third = await server.terminalCommand('unset LOCAL EXPORTED; printf "%s:%s\\n" "$LOCAL" "$EXPORTED"', '/app', undefined, undefined, undefined, second.shellState)
        const fourth = await server.terminalCommand('printf "%s:%s\\n" "$LOCAL" "$EXPORTED"', '/app', undefined, undefined, undefined, third.shellState)
        const fresh = await server.terminalCommand('printf "%s:%s\\n" "$LOCAL" "$EXPORTED"')
        const defined = await server.terminalCommand('greet() { printf "hello %s\\n" "$1"; }', '/app', undefined, undefined, undefined, fourth.shellState)
        const invoked = await server.terminalCommand('greet world', '/app', undefined, undefined, undefined, defined.shellState)
        const removed = await server.terminalCommand('unset -f greet', '/app', undefined, undefined, undefined, invoked.shellState)
        const missing = await server.terminalCommand('greet world', '/app', undefined, undefined, undefined, removed.shellState)
        const freshMissing = await server.terminalCommand('greet world')
        return { first, second, third, fourth, fresh, defined, invoked, removed, missing, freshMissing }
      } finally { await server.close() }
    })
    console.log(name, JSON.stringify({ second: result.second.stdout, third: result.third.stdout, fourth: result.fourth.stdout, fresh: result.fresh.stdout }))
    assert.equal(result.first.exitCode, 0)
    assert.ok(result.first.shellState)
    assert.equal(result.second.exitCode, 0)
    assert.equal(result.second.stdout, 'first:parent\nparent\n')
    assert.equal(result.third.stdout, ':\n')
    assert.equal(result.fourth.stdout, ':\n')
    assert.equal(result.fresh.stdout, ':\n')
    assert.equal(result.defined.exitCode, 0)
    assert.equal(result.invoked.stdout, 'hello world\n')
    assert.equal(result.removed.exitCode, 0)
    assert.equal(result.missing.exitCode, 127)
    assert.equal(result.freshMissing.exitCode, 127)
  } finally { await browser.close() }
}
