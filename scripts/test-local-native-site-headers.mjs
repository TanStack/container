import assert from 'node:assert/strict'

const site = process.env.NATIVE_SITE_ORIGIN ?? 'http://127.0.0.1:4198'
const cases = [
  ['start', 'start-counter', 'require-corp'],
  ['start', 'start-basic', 'require-corp'],
  ['start', 'start-streaming-data-from-server-functions', 'require-corp'],
  ['router', 'basic-ssr-file-based', 'require-corp'],
  ['store', 'simple', 'credentialless'],
]

for (const [library, example, policy] of cases) {
  const response = await fetch(`${site}/${library}/latest/docs/framework/react/examples/${example}?panel=playground`)
  assert.equal(response.status, 200, `${library}/${example}: page failed`)
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin')
  assert.equal(response.headers.get('cross-origin-embedder-policy'), policy, `${library}/${example}: wrong isolation policy`)
  await response.arrayBuffer()
  console.log(`${library}/${example}: ${policy}`)
}
