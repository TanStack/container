import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
import {vmContextCases} from '../../fixtures/vm-context-cases.mjs'

for(const fixture of vmContextCases)test((fixture.kind==='policy'?'VM context policy | ':'VM contexts | ')+fixture.name,async({page},info)=>{
  const source=`import vm from 'node:vm';import {AsyncLocalStorage} from 'node:async_hooks';\n${fixture.code}`
  const reference=spawnSync(process.execPath,['--input-type=module'],{input:source,encoding:'utf8',timeout:5000})
  expect(reference.status,reference.stderr).toBe(0)
  const expected=fixture.kind==='policy'?fixture.expected:reference.stdout
  await page.goto('/sandbox.html')
  const errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));page.on('crash',()=>errors.push('Page crashed'))
  const results=await page.evaluate(async source=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':source})
    try{return {modules:await kernel.runModule('/entry.mjs'),bundle:await kernel.run('/entry.mjs')}}finally{kernel.close()}
  },source)
  await info.attach('vm-context.json',{body:JSON.stringify({name:fixture.name,kind:fixture.kind??'node-comparison',expected,nodeReference:reference.stdout,results}),contentType:'application/json'})
  for(const [mode,result] of Object.entries(results)){
    expect(result.exitCode,mode+': '+result.stderr).toBe(0)
    expect(result.stdout,mode).toBe(expected)
  }
  expect(errors).toEqual([])
})

test('VM context policy | context quota, capabilities, deadlines and recovery',async({page},info)=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/quota.mjs':`import vm from 'node:vm';const contexts=[];for(let i=0;i<64;i++)contexts.push(vm.createContext({i}));let error;try{vm.createContext({})}catch(e){error=e.code};console.log(JSON.stringify([contexts.length,error,vm.createContext(contexts[0])===contexts[0],vm.runInContext('i+42',contexts[0])]));`,
      '/authority.mjs':`import vm from 'node:vm';import fs from 'node:fs';const c=vm.createContext({fs});try{vm.runInContext('fs.writeFileSync("/denied","x")',c)}catch(e){console.log(e.code)};console.log(vm.runInContext('typeof __webContainerHost',c));`,
      '/loop.mjs':`import vm from 'node:vm';const c=vm.createContext({});try{vm.runInContext('while(true){}',c,{timeout:1000})}catch(e){console.log('caught outer deadline')}`,
      '/async-loop.mjs':`import vm from 'node:vm';const c=vm.createContext({});await vm.runInContext('(async()=>{await 0;while(true){}})()',c);`,
      '/allocate.mjs':`import vm from 'node:vm';const c=vm.createContext({});console.log('begin child allocation');vm.runInContext('new Uint8Array(32*1024*1024)',c);console.log('allocated');`,
      '/aggregate.mjs':`console.log('begin aggregate allocation');const values=[];for(let i=0;i<8192;i++)values.push(new Uint8Array(4096));console.log('escaped');`,
    })
    try{
      const quota=await kernel.runModule('/quota.mjs')
      const authority=await kernel.runModule('/authority.mjs',{writable:false})
      const timeout=await kernel.runModule('/loop.mjs',{timeoutMs:150})
      const asyncTimeout=await kernel.runModule('/async-loop.mjs',{timeoutMs:150})
      const lowBudget=await kernel.runModule('/allocate.mjs',{maxBytes:1024*1024})
      const allocation=await kernel.runModule('/allocate.mjs')
      // Exercise retained allocations after boot under the unchanged 16 MiB default.
      // The 1 MiB case above separately checks low-budget failure and recovery.
      const aggregate=await kernel.runModule('/aggregate.mjs')
      const recovery=await kernel.execute('console.log(42)')
      return {quota,authority,timeout,asyncTimeout,lowBudget,allocation,aggregate,recovery,files:Object.keys((await kernel.snapshot()).files)}
    }finally{kernel.close()}
  })
  await info.attach('vm-context-limits.json',{body:JSON.stringify(results),contentType:'application/json'})
  expect(results.quota.exitCode,results.quota.stderr).toBe(0)
  expect(JSON.parse(results.quota.stdout)).toEqual([64,'ERR_RESOURCE_LIMIT',true,42])
  expect(results.authority.exitCode,results.authority.stderr).toBe(0)
  expect(results.authority.stdout).toBe('EACCES\nundefined\n')
  expect(results.files).not.toContain('/denied')
  for(const result of [results.timeout,results.asyncTimeout,results.lowBudget,results.allocation,results.aggregate])expect(result.exitCode,result.stdout).not.toBe(0)
  expect(results.allocation.stdout).toBe('begin child allocation\n')
  expect(results.aggregate.stdout).toBe('begin aggregate allocation\n')
  expect(results.timeout.stdout).not.toContain('caught outer deadline')
  expect(results.recovery.exitCode,results.recovery.stderr).toBe(0)
  expect(results.recovery.stdout).toBe('42\n')
})
