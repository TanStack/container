import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {test} from 'node:test'

function analyze(observed, mutateNative = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'start-demand-test-'))
  try {
    const native = {runs: [1, 2, 3].map(repeat => ({
      repeat, status: 0, workersObserved: 5,
      responses: ['/', '/about'].map(path => ({path, status: 200, expectedContent: true})),
    }))}
    mutateNative(native)
    const guestPath = join(directory, 'guest.json')
    const nativePath = join(directory, 'native.json')
    writeFileSync(guestPath, JSON.stringify({observed}))
    writeFileSync(nativePath, JSON.stringify(native))
    const result = spawnSync(process.execPath, ['scripts/analyze-start-worker-demand.mjs', guestPath, nativePath], {encoding: 'utf8'})
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  } finally {
    rmSync(directory, {recursive: true})
  }
}

function fixture() {
  const event = (tid, kind, at) => ({pid: kind === 'send' ? 2 : 1,
    sample: {tid, protocol: 'cleanup-thread', kind, [kind === 'send' ? 'sentAt' : 'settledAt']: at}})
  return {
    poolAllocations: [{phase: 'throw', message: 'limit', before: {tids: [1, 2, 3, 4]}}],
    jobProfile: [{phase: 'worker-start-failure', pid: 1, at: 100, workerStartError: {message: 'limit'}}],
    workerLifecycle: [event(1, 'send', 90), event(1, 'receive', 106),
      event(2, 'send', 101), event(2, 'receive', 108), event(3, 'receive', 99)],
  }
}

test('distinguishes pending cleanup, later cleanup, settled cleanup and unknown completion', () => {
  const report = analyze(fixture())
  const threads = report.guest.allocationFailures[0].threads
  assert.deepEqual(threads.map(thread => thread.state), [
    'Cleanup sent before rejection, parent settlement still pending',
    'Cleanup sent after rejection',
    'Cleanup settled before rejection, inspect pool bookkeeping',
    'Completion unknown in recorded trace',
  ])
  assert.equal(threads[0].cleanupSettlementAfterFailureMs, 6)
  assert.equal('cleanupSettlementAfterFailureMs' in threads[3], false)
  assert.equal(report.native.allRenderedBothRoutes, true)
})

test('does not associate lifecycle events with an ambiguous allocation failure', () => {
  const observed = fixture()
  observed.poolAllocations.push({...observed.poolAllocations[0]})
  assert.equal(analyze(observed).guest.allocationFailures[0].threads, null)
})

test('flags capped traces and does not report failed native rendering as success', () => {
  const observed = fixture()
  observed.poolAllocations = Array.from({length: 16}, () => observed.poolAllocations[0])
  observed.workerLifecycle = Array.from({length: 256}, () => observed.workerLifecycle[0])
  const report = analyze(observed, native => {native.runs[1].responses[1].expectedContent = false})
  assert.equal(report.guest.traceMayBeTruncated, true)
  assert.equal(report.guest.lifecycleMayBeTruncated, true)
  assert.equal(report.native.allRenderedBothRoutes, false)
})
