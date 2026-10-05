import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {nativeSDKRepeatOptions,nativeSDKRepeatOutcome,nativeSDKRepeatBrowserIdentity,runNativeSDKRepeats} from '../scripts/repeat-native-sdk.mjs'

const options=()=>nativeSDKRepeatOptions(['/sdk','/deployment'])
const identity=()=>({acceptance:{examples:5},runnerLockSHA256:'a'.repeat(64),browserCatalogSHA256:'b'.repeat(64)})
const names=['TanStack Start counter','TanStack Start basic','TanStack Start streaming','TanStack Router file-based SSR','Solid Start counter']
const rows=browser=>names.map(example=>({browser,example,development:'passed'}))
const output=records=>records.map(row=>JSON.stringify(row)).join('\n')
const success=browser=>({status:0,signal:null,stdout:output(rows(browser)),stderr:''})

function browserFixture(){
  const directory=mkdtempSync(join(tmpdir(),'native-sdk-repeat-browser-test-'))
  const packages={}
  writeFileSync(join(directory,'package.json'),'{}')
  for(const name of ['@playwright/test','playwright','playwright-core']){
    const path=join(directory,'node_modules',name)
    mkdirSync(path,{recursive:true})
    writeFileSync(join(path,'package.json'),JSON.stringify({name,version:'1.2.3',exports:{'./package.json':'./package.json'}}))
    packages['node_modules/'+name]={version:'1.2.3'}
  }
  writeFileSync(join(directory,'package-lock.json'),JSON.stringify({packages}))
  writeFileSync(join(directory,'node_modules/playwright-core/browsers.json'),JSON.stringify({browsers:[{name:'webkit',revision:'123'}]}))
  return directory
}

test('browser identity uses installed exported package metadata and reads the adjacent unexported catalog',()=>{
  const directory=browserFixture(),actual=nativeSDKRepeatBrowserIdentity(directory)
  assert.deepEqual(actual.installedVersions,{'@playwright/test':'1.2.3',playwright:'1.2.3','playwright-core':'1.2.3'})
  assert.match(actual.runnerLockSHA256,/^[a-f0-9]{64}$/);assert.match(actual.browserCatalogSHA256,/^[a-f0-9]{64}$/)
  writeFileSync(join(directory,'node_modules/playwright-core/browsers.json'),'{"browsers":[]}')
  assert.notEqual(nativeSDKRepeatBrowserIdentity(directory).browserCatalogSHA256,actual.browserCatalogSHA256)
})

test('browser identity rejects missing locked versions and installed version mismatches',()=>{
  for(const change of ['missing','mismatch']){
    const directory=browserFixture(),lock=JSON.parse(readFileSync(join(directory,'package-lock.json')))
    if(change==='missing')delete lock.packages['node_modules/playwright-core'].version
    else lock.packages['node_modules/playwright-core'].version='9.9.9'
    writeFileSync(join(directory,'package-lock.json'),JSON.stringify(lock))
    assert.throws(()=>nativeSDKRepeatBrowserIdentity(directory),change==='missing'?/locked version/:/differs from its lock/)
  }
})

test('SDK repeats default to all engines and require bounded explicit options without filters',()=>{
  assert.deepEqual(options(),{sdk:'/sdk',deployment:'/deployment',runs:2,browser:'all'})
  assert.equal(nativeSDKRepeatOptions(['/sdk','/deployment','--runs','5','--browser','webkit']).runs,5)
  for(const flags of [['--runs','0'],['--runs','1'],['--runs','6'],['--runs','2','--runs','3'],
    ['--runs'],['--example','counter'],['--browser','safari']])
    assert.throws(()=>nativeSDKRepeatOptions(['/sdk','/deployment',...flags]))
  assert.throws(()=>nativeSDKRepeatOptions([]))
})

test('SDK repeat accounting requires all original examples in order and the requested engine',()=>{
  assert.equal(nativeSDKRepeatOutcome(success('webkit'),'webkit').passed,true)
  for(const change of [records=>records.pop(),records=>records.reverse(),records=>records[1]=records[0],
    records=>records[0].browser='firefox',records=>records[0].development='failed']){
    const records=rows('webkit');change(records)
    assert.equal(nativeSDKRepeatOutcome({...success('webkit'),stdout:output(records)},'webkit').passed,false)
  }
})

test('SDK repeat accounting cannot pass nonzero exits, signals, errors, malformed or absent output',()=>{
  for(const fields of [{status:1},{status:null},{signal:'SIGTERM'},{error:Error('spawn failed')},
    {stdout:''},{stdout:success('webkit').stdout+'\n{"browser":invalid'}])
    assert.equal(nativeSDKRepeatOutcome({...success('webkit'),...fields},'webkit').passed,false)
})

test('SDK repeats run two complete original matrices with all tracing and narrowing flags cleared',()=>{
  const calls=[]
  const receipt=runNativeSDKRepeats(options(),{projectRoot:'/project',identity,
    env:{PATH:'/bin',NATIVE_OWNER_TRACE:'1',NATIVE_OWNER_STREAM_OBSERVE:'1',NATIVE_OWNER_EXAMPLE:'counter',TANSTACK_ROUTER_SOURCE:'/other'},
    run:(command,args,settings)=>{
      calls.push({command,args,settings})
      return success(settings.env.NATIVE_TEST_BROWSER)
    }})
  assert.equal(receipt.passed,true);assert.equal(receipt.complete,true)
  assert.deepEqual(receipt.rows.map(row=>[row.iteration,row.browser]),[
    [1,'chromium'],[1,'firefox'],[1,'webkit'],[2,'chromium'],[2,'firefox'],[2,'webkit']])
  for(const call of calls){
    assert.equal(call.command,process.execPath)
    assert.deepEqual(call.args,['--test','--test-force-exit','--test-timeout=180000','/project/tests/native-owner-sdk.test.mjs'])
    assert.equal(call.settings.maxBuffer,64*1024*1024)
    assert.deepEqual(Object.keys(call.settings.env).sort(),['PATH','NATIVE_TEST_BROWSER','NATIVE_SDK_BUNDLE_DIR',
      'NATIVE_DEPLOYMENT_DIR','NATIVE_OWNER_RUNTIME_CATALOG','NATIVE_OWNER_PINNED_EXAMPLES'].sort())
  }
})

test('SDK repeats retain the first failure and its log, then stop instead of retrying',()=>{
  let calls=0
  const receipt=runNativeSDKRepeats(options(),{projectRoot:'/project',identity,run:(_command,_args,settings)=>{
    calls++;return calls===2?{...success(settings.env.NATIVE_TEST_BROWSER),status:1,stderr:'original failure\n'}:success(settings.env.NATIVE_TEST_BROWSER)
  }})
  assert.equal(calls,2);assert.equal(receipt.complete,false);assert.equal(receipt.passed,false)
  assert.deepEqual(receipt.rows.map(row=>row.passed),[true,false])
  assert.ok(readFileSync(receipt.rows[1].log,'utf8').endsWith('original failure\n'))
  assert.deepEqual(JSON.parse(readFileSync(receipt.output+'/results.json')).rows,JSON.parse(JSON.stringify(receipt.rows)))
})

test('changed SDK or browser inputs fail and stop a repeat without losing the completed command log',()=>{
  let checks=0,calls=0
  const receipt=runNativeSDKRepeats(options(),{projectRoot:'/project',identity:()=>({revision:++checks}),
    run:(_command,_args,settings)=>{calls++;return success(settings.env.NATIVE_TEST_BROWSER)}})
  assert.equal(calls,1);assert.equal(receipt.passed,false);assert.equal(receipt.complete,false)
  assert.match(receipt.rows[0].inputError,/inputs changed/)
  assert.ok(readFileSync(receipt.rows[0].log,'utf8').includes('Solid Start counter'))
})

test('thrown command failures retain their output and cannot become a successful receipt',()=>{
  const failure=Object.assign(Error('original failure'),{stdout:'earlier output\n',stderr:'original diagnostic\n'})
  const receipt=runNativeSDKRepeats(options(),{projectRoot:'/project',identity,run:()=>{throw failure}})
  assert.equal(receipt.passed,false);assert.equal(receipt.rows.length,1)
  assert.equal(receipt.rows[0].status,null);assert.match(receipt.rows[0].error,/original failure/)
  assert.equal(readFileSync(receipt.rows[0].log,'utf8'),'earlier output\noriginal diagnostic\n')
})

test('single-engine diagnostics stay explicitly scoped and still run two full workflows',()=>{
  const receipt=runNativeSDKRepeats({...options(),browser:'webkit'},{projectRoot:'/project',identity,
    run:(_command,_args,settings)=>success(settings.env.NATIVE_TEST_BROWSER)})
  assert.deepEqual(receipt.browsers,['webkit']);assert.equal(receipt.rows.length,2)
  assert.equal(receipt.passed,true)
})
