import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

test('fiber runtime keeps documented native stack headroom',()=>{
  const worker=readFileSync('src/sandbox/kernel.worker.ts','utf8')
  const binding=readFileSync('src/sandbox/guest-fiber-call.c','utf8')
  const build=readFileSync('scripts/build-quickjs-als.mjs','utf8')
  assert.match(worker,/setMaxStackSize\(\(experimentalFibers\?384:512\)\*1024\)/)
  assert.match(binding,/#define QTS_FIBER_STACK_BYTES \(512 \* 1024\)/)
  assert.match(build,/stackBytes:512\*1024,quickJSStackBytes:384\*1024,nativeHeadroomBytes:128\*1024/)
})
