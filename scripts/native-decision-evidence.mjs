import assert from 'node:assert/strict'

export const nativeContextGaps=new Set([
  'thenable-assimilation','async-function-constructor','eval-native-await',
  'native-await-no-then-hook','generator-queued-next','untransformed-library-await',
])

// Passing means the bounded experiment reproduced, not that native can replace
// QuickJS. Known context gaps stay visible and are never converted into matches.
export function verifyNativeDecisionEvidence(report){
  assert.deepEqual(report.browsers.map(browser=>browser.name).sort(),['chromium','firefox'])
  assert.equal(report.cases.length,40)
  for(const browser of report.browsers){
    assert.equal(browser.fatal,undefined)
    assert.deepEqual(browser.pageErrors,[])
    assert.deepEqual(browser.consoleErrors,[])
    assert.equal(browser.context.length,report.cases.length)
    assert.deepEqual(browser.context.map(row=>row.id),report.cases.map(row=>row.id))
    for(const row of browser.context)assert.ok(row.lowered.matches||nativeContextGaps.has(row.id),'Unexpected context regression: '+row.id)
    assert.equal(browser.viteDev.error,undefined)
    assert.equal(browser.viteDev.result.listening,true)
    assert.equal(browser.viteDev.result.htmlStatus,200)
    assert.equal(browser.viteDev.result.html,true)
    assert.equal(browser.viteDev.result.moduleStatus,200)
    assert.equal(browser.viteDev.result.module,true)
    assert.equal(browser.viteDev.result.editedStatus,200)
    assert.equal(browser.viteDev.result.edited,true)
    assert.equal(browser.viteDev.result.hmrConnected,true)
    assert.equal(browser.viteDev.result.hmrUpdate,'update')
    const {install,results}=browser.workloads
    assert.equal(install.runtime,'native-worker')
    assert.ok(install.packages>0&&install.files>0&&install.bytes>0)
    assert.match(install.sha256,/^[a-f0-9]{64}$/)
    assert.equal(browser.resume.sha256,install.sha256)
    assert.equal(browser.resume.files,install.files)
    assert.equal(browser.resume.bytes,install.bytes)
    assert.ok(browser.resume.artifacts.includes('/app/dist/server/server.js'))
    assert.equal(results.filter(row=>row.type==='vite-build'&&row.passed).length,3)
    const start=results.find(row=>row.type==='start-build-and-native-ssr')
    assert.equal(start.execution,'worker-owned-entry')
    assert.equal(start.load.ok,true)
    assert.equal(start.responses.length,3)
    for(const response of start.responses){assert.equal(response.ok,true);assert.equal(response.value.status,200)}
    assert.equal(browser.preview.passed,true)
    assert.deepEqual(browser.preview.errors,[])
    assert.equal(browser.preview.mismatchedOrigin.status,403)
    const reply=JSON.parse(browser.preview.serverReply)
    assert.equal(reply.method,'POST');assert.ok(reply.origin);assert.equal(reply.origin,reply.clonedOrigin)
    assert.equal(browser.preview.edit.loaded.ok,true)
    assert.equal(browser.controls.terminatedBeforeCompletion,true)
    assert.equal(browser.controls.pendingRejected,true)
    assert.ok(browser.controls.hostHeartbeatTicks>0)
  }
  return {experimentPassed:true,replacementApproved:false,
    reason:'Native context gaps, missing guest heap quota and incomplete full-runtime parity remain.'}
}
