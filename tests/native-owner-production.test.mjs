import assert from 'node:assert/strict'
import test from 'node:test'
import {nativeReleaseExamples} from '../scripts/native-example-sources.mjs'
import {productionMatrixPlan,productionMatrixOutcome,probeNativeOwnerProduction} from '../scripts/probe-native-owner-production.mjs'

const options={root:'/examples',sdk:'/installed/sdk',deployment:'/installed/hosted',env:{PATH:'/bin',
  NATIVE_OWNER_PRODUCTION:'0',NATIVE_OWNER_VITE_ONLY_PROBE:'1',NATIVE_OWNER_CONTINUE_ON_FAILURE:'1',
  NATIVE_OWNER_EXAMPLE:'start-counter',NATIVE_TEST_BROWSER:'chromium',TANSTACK_ROUTER_SOURCE:'/neighbor'}}
const plan=productionMatrixPlan(options)
const success=cell=>({status:0,signal:null,stdout:JSON.stringify({browser:cell.browser,example:cell.example,
  development:'passed',restart:'not requested',productionBuild:'declared-script API',production:'passed'}),stderr:''})

test('production matrix requires all five original examples in every engine',()=>{
  assert.equal(plan.length,15)
  assert.equal(new Set(plan.map(cell=>cell.browser+'/'+cell.fixture)).size,15)
  for(const browser of ['chromium','firefox','webkit'])assert.equal(plan.filter(cell=>cell.browser===browser).length,5)
  for(const cell of plan){
    const example=nativeReleaseExamples.find(example=>example.fixture===cell.fixture)
    assert.deepEqual(cell.args,['--test','--test-force-exit','--test-timeout=180000','/examples/tests/native-owner-sdk.test.mjs'])
    assert.deepEqual(cell.options.env,{PATH:'/bin',NATIVE_SDK_BUNDLE_DIR:options.sdk,NATIVE_DEPLOYMENT_DIR:options.deployment,
      NATIVE_OWNER_RUNTIME_CATALOG:'1',NATIVE_OWNER_PINNED_EXAMPLES:'1',NATIVE_OWNER_TIMINGS:'1',NATIVE_TEST_BROWSER:cell.browser,
      NATIVE_OWNER_PRODUCTION:'1',NATIVE_OWNER_EXAMPLE:example.kind+'/'+example.path})
  }
})

test('production outcome requires the declared build and production assertions',()=>{
  assert.equal(productionMatrixOutcome(success(plan[0]),plan[0]).passed,true)
  for(const patch of [{production:'not requested'},{production:'Vite-only probe'},{productionBuild:'Vite API'},
    {development:'failed'},{browser:'webkit'},{example:'other'}]){
    const child=success(plan[0])
    child.stdout=JSON.stringify({...JSON.parse(child.stdout),...patch})
    assert.equal(productionMatrixOutcome(child,plan[0]).passed,false)
  }
})

test('process failure cannot pass with a success marker',()=>{
  for(const patch of [{status:1},{status:null},{signal:'SIGTERM'},{error:Error('timeout')}])
    assert.equal(productionMatrixOutcome({...success(plan[0]),...patch},plan[0]).passed,false)
  for(const stdout of ['', '{"development":','{}',success(plan[0]).stdout+'\n'+success(plan[0]).stdout])
    assert.equal(productionMatrixOutcome({...success(plan[0]),stdout},plan[0]).passed,false)
})

test('a failed cell stays failed while all later required cells are measured',async()=>{
  let count=0
  const receipt=await probeNativeOwnerProduction(options,{inputs:()=>({fixed:true}),run:async(_command,_args,entry)=>{
    const cell=plan.find(cell=>cell.options.env.NATIVE_TEST_BROWSER===entry.env.NATIVE_TEST_BROWSER&&
      cell.options.env.NATIVE_OWNER_EXAMPLE===entry.env.NATIVE_OWNER_EXAMPLE)
    count++
    return count===1?{...success(cell),status:1}:success(cell)
  }})
  assert.equal(receipt.rows.length,15)
  assert.equal(receipt.complete,true)
  assert.equal(receipt.passed,false)
  assert.equal(receipt.rows[0].passed,false)
  assert.equal(receipt.rows.slice(1).every(row=>row.passed&&row.inputsUnchanged),true)
})

test('changed input identity stops the matrix and cannot pass',async()=>{
  let reads=0
  const receipt=await probeNativeOwnerProduction(options,{inputs:()=>({revision:reads++}),run:async(_command,_args,entry)=>{
    const cell=plan.find(cell=>cell.options.env.NATIVE_TEST_BROWSER===entry.env.NATIVE_TEST_BROWSER&&
      cell.options.env.NATIVE_OWNER_EXAMPLE===entry.env.NATIVE_OWNER_EXAMPLE)
    return success(cell)
  }})
  assert.equal(receipt.passed,false)
  assert.equal(receipt.complete,false)
  assert.ok(receipt.interrupted)
  assert.ok(receipt.rows.some(row=>row.inputError))
  assert.ok(receipt.rows.length<15)
})

test('React and Solid counters have different valid selectors',()=>{
  const selectors=plan.filter(cell=>cell.browser==='chromium').map(cell=>cell.options.env.NATIVE_OWNER_EXAMPLE)
  assert.deepEqual(selectors,['react/start-counter','react/start-basic',
    'react/start-streaming-data-from-server-functions','react/basic-ssr-file-based','solid/start-counter'])
  assert.equal(new Set(selectors).size,5)
})

test('unexpected runner rejection drains the cancelled sibling before returning',async()=>{
  let started=0,drained=false
  const receipt=await probeNativeOwnerProduction(options,{inputs:()=>({fixed:true}),run:async(_command,_args,_entry,{signal})=>{
    if(++started===1)throw Error('Runner failed')
    return new Promise(resolve=>{
      const finish=()=>{drained=true;resolve({status:null,signal:'SIGTERM'})}
      if(signal.aborted)finish()
      else signal.addEventListener('abort',finish,{once:true})
    })
  }})
  assert.equal(drained,true)
  assert.equal(started,2)
  assert.equal(receipt.complete,false)
  assert.equal(receipt.passed,false)
  assert.match(receipt.runnerError,/Runner failed/)
})

test('an already cancelled matrix starts no browser processes',async()=>{
  const controller=new AbortController();controller.abort(Error('Cancelled'))
  const receipt=await probeNativeOwnerProduction(options,{inputs:()=>({fixed:true}),signal:controller.signal,
    run:async()=>{throw Error('Must not run')}})
  assert.equal(receipt.rows.length,0)
  assert.equal(receipt.passed,false)
  assert.match(receipt.interrupted,/Cancelled/)
})
