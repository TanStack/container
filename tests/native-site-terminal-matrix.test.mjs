import assert from 'node:assert/strict'
import test from 'node:test'
import {copyFileSync,mkdirSync,mkdtempSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {terminalMatrixOptions,terminalMatrixPlan,terminalMatrixRunner,terminalMatrixProject,terminalMatrixOutcome,runTerminalMatrix} from '../scripts/probe-local-native-terminal-matrix.mjs'

const args=['/private/tmp/tanstack-native-site-test','/private/tmp/sdk-test','/private/tmp/deployment-test']
const options=terminalMatrixOptions(args)
const identity={runner:{directory:'/private/tmp/verified-terminal-runner'},entrypoint:'/private/tmp/verified-terminal-runner/scripts/test-local-native-terminal-examples.mjs'}
const success=(browser,example)=>({status:0,stdout:`${browser}: ${example} run 1/1 terminal, input, interrupt, failures, editor, live preview edit, build, resize, reopen, restart passed\n`})

test('terminal matrix always plans all four examples on all three browsers',()=>{
  assert.equal(options.browser,'all');assert.equal(options.runs,1)
  const plan=terminalMatrixPlan()
  assert.equal(plan.length,12)
  assert.equal(new Set(plan.map(cell=>cell.browser+':'+cell.example)).size,12)
  for(const flags of [['--browser','chromium'],['--runs','2'],['--example','start-basic'],['--site','http://example.com:4538'],['--runner','/'],['--site']])
    assert.throws(()=>terminalMatrixOptions([...args,...flags]))
})

test('terminal completion requires exactly one matching full milestone and a clean exit',()=>{
  const child=success('chromium','start-basic')
  assert.equal(terminalMatrixOutcome(child,'chromium','start-basic').passed,true)
  for(const invalid of [{...child,status:1},{...child,signal:'SIGTERM'},{...child,error:Error('timeout')},
    {...child,stdout:''},{...child,stdout:child.stdout+child.stdout},success('firefox','start-basic'),success('chromium','start-counter')])
    assert.equal(terminalMatrixOutcome(invalid,'chromium','start-basic').passed,false)
})

test('terminal runner binds unchanged source, the actual shared lock and the browser catalog',()=>{
  const directory=mkdtempSync(join(tmpdir(),'native-terminal-runner-test-'))
  const dependencyRoot=mkdtempSync(join(tmpdir(),'native-terminal-deps-test-'))
  mkdirSync(join(directory,'scripts'));mkdirSync(join(dependencyRoot,'node_modules/playwright-core'),{recursive:true})
  symlinkSync(join(dependencyRoot,'node_modules'),join(directory,'node_modules'),'dir')
  for(const name of ['test-local-native-terminal-examples.mjs','native-terminal-viewport.mjs'])
    copyFileSync(new URL('../scripts/'+name,import.meta.url),join(directory,'scripts',name))
  const names=['@playwright/test','playwright','playwright-core']
  const metadata={directory,packages:Object.fromEntries(names.map(name=>[name,{version:'1.63.0'}]))}
  const lockPath=join(dependencyRoot,'package-lock.json')
  const lock={packages:Object.fromEntries(names.map(name=>['node_modules/'+name,{version:'1.63.0'}]))}
  writeFileSync(lockPath,JSON.stringify(lock))
  writeFileSync(join(dependencyRoot,'node_modules/playwright-core/browsers.json'),'{}')
  const bound=terminalMatrixRunner(metadata)
  assert.equal(bound.dependencyRoot,realpathSync(dependencyRoot))
  assert.equal(Object.keys(bound.terminalHashes).length,2)
  lock.packages['node_modules/playwright-core'].version='1.62.1'
  writeFileSync(lockPath,JSON.stringify(lock))
  assert.throws(()=>terminalMatrixRunner(metadata),/lock differs/)
  lock.packages['node_modules/playwright-core'].version='1.63.0'
  writeFileSync(lockPath,JSON.stringify(lock))
  writeFileSync(join(directory,'scripts/native-terminal-viewport.mjs'),'// changed')
  assert.throws(()=>terminalMatrixRunner(metadata),/source differs/)
})

test('terminal matrix verifies every pinned example byte and its original lock identity',()=>{
  const expected={revision:'revision',sourceSHA256:'source',npmLockSHA256:'lock',files:{'/project/main.ts':'hello','/project/asset.bin':new Uint8Array([0,128,255])}}
  const project={sourceRevision:'revision',sourceSHA256:'source',npmLockSHA256:'lock',files:{'/project/main.ts':'hello'},binaryFiles:{'/project/asset.bin':'AID/'}}
  assert.doesNotThrow(()=>terminalMatrixProject(project,expected))
  for(const changed of [
    {...project,sourceRevision:'other'},
    {...project,files:{'/project/main.ts':'changed'}},
    {...project,binaryFiles:{}},
    {...project,files:{...project.files,'/project/extra.ts':'extra'}},
    {...project,binaryFiles:{...project.binaryFiles,'/project/main.ts':'aGVsbG8='}},
    {...project,binaryFiles:{'/project/asset.bin':'AID/\n'}},
  ])assert.throws(()=>terminalMatrixProject(changed,expected))
})

test('failed cells remain failed while later example and browser pairs still run',async()=>{
  let calls=0
  const receipt=await runTerminalMatrix(options,{inputs:()=>identity,
    env:{NATIVE_EXAMPLES:'start-basic',NATIVE_BROWSER:'chromium',NATIVE_EXAMPLE_REPETITIONS:'9',LOCAL_NATIVE_COUNTER_ONLY:'1',PATH:'/test'},
    run:async(command,argv,childOptions)=>{
      assert.deepEqual(argv,[identity.entrypoint])
      assert.equal(childOptions.cwd,identity.runner.directory)
      assert.equal(childOptions.env.LOCAL_NATIVE_COUNTER_ONLY,undefined)
      assert.equal(childOptions.env.NATIVE_EXAMPLE_REPETITIONS,'1')
      assert.equal(childOptions.env.PATH,'/test')
      const {NATIVE_BROWSER:browser,NATIVE_EXAMPLES:example}=childOptions.env
      calls++
      return calls===1?{status:1,stdout:'first cell failed'}:success(browser,example)
    }})
  assert.equal(calls,12);assert.equal(receipt.complete,true);assert.equal(receipt.passed,false)
  assert.equal(receipt.rows[0].passed,false);assert.equal(receipt.rows.at(-1).passed,true)
})

test('all cells require stable inputs and no failed rows',async()=>{
  const receipt=await runTerminalMatrix(options,{inputs:()=>identity,run:async(command,argv,{env})=>success(env.NATIVE_BROWSER,env.NATIVE_EXAMPLES)})
  assert.equal(receipt.complete,true);assert.equal(receipt.passed,true)
  let reads=0,calls=0
  const changed=await runTerminalMatrix(options,{inputs:()=>({...identity,revision:reads++}),run:async()=>{calls++;return success('chromium','start-counter')}})
  assert.equal(calls,1);assert.equal(changed.complete,false);assert.equal(changed.passed,false)
  assert.match(changed.stoppedReason,/inputs changed/)
})

test('pre-cancelled and interrupted matrices never claim completion',async()=>{
  const controller=new AbortController();controller.abort(Error('cancelled'))
  let calls=0
  const cancelled=await runTerminalMatrix(options,{inputs:()=>identity,signal:controller.signal,run:async()=>{calls++}})
  assert.equal(calls,0);assert.equal(cancelled.complete,false);assert.equal(cancelled.passed,false)
  const during=new AbortController()
  const interrupted=await runTerminalMatrix(options,{inputs:()=>identity,signal:during.signal,run:async()=>{
    during.abort(Error('cancelled'));return {status:null,signal:'SIGTERM'}
  }})
  assert.equal(interrupted.rows.length,1);assert.equal(interrupted.complete,false);assert.equal(interrupted.passed,false)
})
