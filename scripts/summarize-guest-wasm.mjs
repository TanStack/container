import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {weakmapLifetimeCases,weakmapLifetimeSource} from '../fixtures/weakmap-lifetime-cases.mjs'
import {guestWasmCases} from '../fixtures/guest-wasm-cases.mjs'
import {guestWasmInputHashes} from './guest-wasm-evidence.mjs'
const json=file=>JSON.parse(readFileSync(file,'utf8'))
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const engine=json('public/quickjs-als-wasm/build.json')
if(engine.wasmSha256!==hash('public/quickjs-als-wasm/engine.wasm')||engine.guestWasm.bridgeSHA256!==hash('src/sandbox/guest-wasm.c')||engine.guestWasm.bootstrapSHA256!==hash('src/sandbox/guest-wasm.js'))throw Error('Engine and source fingerprints differ')
for(const [name,sha] of Object.entries(engine.guestWasm.patches))if(hash('patches/'+name)!==sha)throw Error('Engine patch fingerprint differs: '+name)
const browser=json('reports/guest-wasm-browser-results.json'),node=json('reports/guest-wasm-node.json'),allocation=json('reports/guest-wasm-allocation.json'),native=json('reports/guest-wasm-asan.json'),weakmap=json('reports/weakmap-lifetime.json')
for(const evidence of [browser.config.metadata.engine,node.engine,allocation.engine,native.engine,weakmap.engine])if(evidence.wasmSha256!==engine.wasmSha256||evidence.guestWasm.bootstrapSHA256!==engine.guestWasm.bootstrapSHA256)throw Error('Evidence uses a different engine or bootstrap')
const inputs=guestWasmInputHashes()
const budget=json('reports/wasm-budget.json')
if(budget.engine.wasmSha256!==engine.wasmSha256||JSON.stringify(budget.inputs)!==JSON.stringify(inputs))throw Error('WASM budget evidence uses different inputs')
const budgetNames=['fallback-finite','fallback-loop','host-finite','host-loop','host-start-loop','handler-removed']
if(budget.rows.length!==budgetNames.length||budgetNames.some(name=>budget.rows.filter(row=>row.name===name&&row.passed&&row.status===0).length!==1))throw Error('WASM budget policy coverage is incomplete')
for(const evidence of [browser.config.metadata,node,allocation,native])if(JSON.stringify(evidence.inputs)!==JSON.stringify(inputs))throw Error('Evidence fixture, harness or engine input fingerprints differ')
if(!browser.config.metadata.sources)throw Error('Browser source fingerprints are missing')
for(const [path,sha] of Object.entries(browser.config.metadata.sources))if(hash(path)!==sha)throw Error('Browser source fingerprint differs: '+path)
if(node.rows.length!==guestWasmCases.length||new Set(node.rows.map(row=>row.name)).size!==guestWasmCases.length||guestWasmCases.some(fixture=>!node.rows.some(row=>row.name===fixture.name)))throw Error('Node comparison corpus is incomplete')
for(const [phase,counts] of Object.entries(allocation.summary)){
  const rows=allocation.rows.filter(row=>row.phase===phase)
  if(rows.length!==257||new Set(rows.map(row=>row.headroom)).size!==257||rows.some(row=>row.answer!==42||row.headroom<0||row.headroom>512*1024||row.headroom%2048!==0)||!counts.failed||!counts.passed||counts.failed!==rows.filter(row=>row.failed).length||counts.passed!==rows.filter(row=>!row.failed).length)throw Error('Allocation/recovery coverage is incomplete: '+phase)
}
if(allocation.rows.length!==Object.keys(allocation.summary).length*257)throw Error('Unexpected allocation rows')
if(weakmap.fixtureSHA256!==createHash('sha256').update(weakmapLifetimeSource).digest('hex')||weakmap.harnessSHA256!==hash('fixtures/weakmap-lifetime-native.c'))throw Error('WeakMap probe fingerprint differs')
const workloads=[],checks=[]
function walk(suite){
  for(const spec of suite.specs??[])for(const test of spec.tests??[])checks.push({browser:test.projectName,name:spec.title,status:test.results?.at(-1)?.status})
  for(const spec of suite.specs??[])for(const test of spec.tests??[])for(const result of test.results??[])for(const attachment of result.attachments??[])if(attachment.name==='candidate-workload.json'){
    workloads.push({browser:test.projectName,...JSON.parse(Buffer.from(attachment.body,'base64').toString())})
  }
  for(const child of suite.suites??[])walk(child)
}
walk(browser)
for(const project of ['chromium','firefox','webkit']){
  for(const name of [...guestWasmCases.map(row=>row.name),'retained numeric globals do not retain discarded instance memory','global mutations preserve ALS across callbacks and async instantiation','cleared tables release instance memory while retained entries remain callable','shared table callbacks and growth preserve ALS',...['block','loop','if','else'].map(kind=>`compiler handles deep ${kind} nesting without host recursion`)]){
    const found=checks.filter(row=>row.browser===project&&row.name===name)
    if(found.length!==1||found[0].status!=='passed')throw Error('Missing or failed browser check: '+project+' '+name)
  }
  for(const name of ['host deadline permits finite WASM work beyond the fallback instruction allowance','WASM deadlines stop promise jobs and cannot be caught by the guest']){
    if(checks.filter(row=>row.browser===project&&row.name===name&&row.status==='passed').length!==1)throw Error('Missing WASM budget browser check: '+project+' '+name)
  }
}
const output={generatedAt:new Date().toISOString(),engine,browser:browser.stats,
  packageExperiments:workloads.length,packagePasses:workloads.filter(row=>row.status==='pass'||row.status==='adapted-pass').length,
  dedicatedChecks:browser.stats.expected-workloads.length,nodeMatches:node.rows.filter(row=>row.passed).length,
  budgetChecks:budget.rows.length,
  allocationCases:allocation.rows.length,allocation:allocation.summary,
  native:{buildStatus:native.build.status,runStatus:native.run.status,result:native.run.status===0?JSON.parse(native.run.stdout):null},
  weakmap:{cases:weakmap.rows.length,reclaimed:weakmap.rows.filter(row=>row.status==='reclaimed').length,gaps:weakmap.rows.filter(row=>row.status!=='reclaimed'),unexpected:weakmap.unexpected},
  workloads:workloads.map(({browser,id,status,stage,error,iterations,durationMs})=>({browser,id,status,stage,error,iterations:iterations.length,durationMs}))}
writeFileSync('reports/guest-wasm-summary.json',JSON.stringify(output,null,2)+'\n')
console.log(JSON.stringify({...output,engine:engine.wasmSha256,workloads:output.workloads.map(row=>({...row,error:row.error?.split('\n')[0]}))},null,2))
if(browser.stats.unexpected||browser.stats.flaky||browser.stats.skipped||node.rows.some(row=>!row.passed)||native.build.status||native.run.status||weakmap.build.status||weakmap.run?.status!==0||weakmap.rows.length!==weakmapLifetimeCases.length||weakmap.unexpected)process.exitCode=1
