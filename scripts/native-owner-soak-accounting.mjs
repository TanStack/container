import assert from 'node:assert/strict'
import {checkNativeOwnerSoak,nativeOwnerSoakCycles} from './native-owner-soak.mjs'

export function readNativeOwnerSoakResults(output,toolchains){
  assert.ok(Array.isArray(toolchains)&&toolchains.length===2,'Owner soak requires both toolchains')
  const records=String(output).split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
  const inputs=records.filter(row=>row.kind==='owner-soak-inputs')
  assert.equal(inputs.length,3,'Owner soak requires all three input records')
  assert.deepEqual(inputs.map(row=>row.selected),[['chromium'],['firefox'],['webkit']])
  for(const input of inputs){
    assert.equal(input.cycles,nativeOwnerSoakCycles)
    for(const field of ['testSHA256','workloadSHA256','runnerLockSHA256']){
      assert.match(input[field],/^[a-f0-9]{64}$/)
      assert.equal(input[field],inputs[0][field],'Owner soak inputs changed')
    }
    assert.deepEqual(input.identity,inputs[0].identity,'Owner soak package identity changed')
    for(const field of ['sdkManifestSHA256','runtimeManifestSHA256','deploymentManifestSHA256','examplesManifestSHA256'])
      assert.match(input.identity?.[field],/^[a-f0-9]{64}$/)
  }
  const rows=records.filter(row=>row.kind==='owner-soak-result')
  const cycles=records.filter(row=>row.kind==='owner-soak-cycle')
  assert.equal(rows.length,6,'Owner soak must complete six browser/toolchain pairs')
  assert.equal(cycles.length,6*nativeOwnerSoakCycles,'Owner soak must retain every cycle')
  for(const browser of ['chromium','firefox','webkit'])for(const toolchain of toolchains){
    const matches=row=>row.browser===browser&&row.toolchain?.vite===toolchain.vite&&row.toolchain?.rolldown===toolchain.rolldown
    const matching=rows.filter(matches)
    assert.equal(matching.length,1,'Missing or duplicate owner soak pair')
    const row=matching[0]
    assert.equal(row.passed,true,'Owner soak failed')
    assert.ok(typeof row.version==='string'&&row.version,'Owner soak browser version missing')
    assert.deepEqual(row.diagnostics,[],'Owner soak diagnostics')
    checkNativeOwnerSoak(row.cycles,row.errors)
    const emitted=cycles.filter(matches).map(({kind,browser,toolchain,...cycle})=>cycle)
    assert.deepEqual(emitted,row.cycles,'Emitted owner soak cycles differ from final result')
  }
  return {inputs:inputs[0],rows,cycles:cycles.length}
}
