import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
import cases from '../../fixtures/guest-script-cases.json' with {type:'json'}

for(const execution of ['modules','bundle'] as const)test('Node VM | '+execution+' | compiled async functions retain overlapping ALS context',async({page})=>{
  const source=`
    import vm from 'node:vm';import {AsyncLocalStorage} from 'node:async_hooks';
    globalThis.als=new AsyncLocalStorage();globalThis.readStore=()=>als.getStore();
    const task=vm.runInThisContext('(async function(gate){const before=readStore();await gate;await Promise.resolve();return [before,readStore()]})');
    let release;const gate=new Promise(resolve=>release=resolve);
    const a=als.run('a',()=>task(gate)),b=als.run('b',()=>task(gate));
    als.run('resolver',release);
    const results=await Promise.all([a,b]);
    const generated=vm.runInThisContext('(async function(){await Promise.resolve();return readStore()})');
    results.push(await als.run('late',()=>generated()),als.getStore()===undefined);
    console.log(JSON.stringify(results));`
  const reference=spawnSync(process.execPath,['--input-type=module'],{input:source,encoding:'utf8',timeout:5000})
  expect(reference.status,reference.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,execution})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':source})
    try{return await (execution==='modules'?kernel.runModule('/entry.mjs'):kernel.run('/entry.mjs'))}finally{kernel.close()}
  },{source,execution})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(reference.stdout)
})

for(const fixture of cases)for(const execution of ['modules','bundle'] as const)test('Node VM | '+execution+' | '+fixture.name,async({page})=>{
  const source=`import vm from 'node:vm';\n${fixture.code}`
  const node=spawnSync(process.execPath,['--input-type=module'],{input:source,encoding:'utf8',timeout:5000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,execution})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':source})
    try{return await (execution==='modules'?kernel.runModule('/entry.mjs'):kernel.run('/entry.mjs'))}finally{kernel.close()}
  },{source,execution})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(node.stdout)
})

test('Node VM | guest scripts retain outer authority, limits, and recovery',async({page})=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':`
      import vm from 'node:vm';import fs from 'node:fs';globalThis.fs=fs;
      const seen=[vm.runInThisContext('typeof document+","+typeof fetch'),typeof globalThis.__qjsCompileScript,typeof globalThis.__qjsDisableStringCodeGeneration,typeof globalThis.__qjsCreateContext,typeof globalThis.__qjsExecutePendingJobs];
      try{vm.runInThisContext('fs.writeFileSync("/denied","value")')}catch(error){seen.push(error.code)}
      for(const action of [()=>vm.compileFunction('return 42'),()=>new vm.Script('42',{cachedData:new Uint8Array()}),()=>vm.runInThisContext('42',{breakOnSigint:true})]){
        try{action();seen.push('unexpected')}catch(error){seen.push(error.code)}
      }
      console.log(JSON.stringify(seen));`,
      '/loop.mjs':`import vm from 'node:vm';try{vm.runInThisContext('while(true){}',{timeout:1000})}catch(error){console.log('caught outer deadline')}`,
      '/heap.mjs':`import vm from 'node:vm';vm.runInThisContext('const values=[];for(;;)values.push(new Array(10000).fill(42))')`,
    })
    try{
      const policy=await kernel.runModule('/entry.mjs',{writable:false})
      const timeout=await kernel.runModule('/loop.mjs',{timeoutMs:100})
      const heap=await kernel.runModule('/heap.mjs',{maxBytes:4*1024*1024})
      return {policy,timeout,heap,files:Object.keys((await kernel.snapshot()).files),recovery:await kernel.execute('console.log(42)')}
    }finally{kernel.close()}
  })
  expect(results.policy.exitCode,results.policy.stderr).toBe(0)
  expect(JSON.parse(results.policy.stdout)).toEqual(['undefined,undefined','undefined','undefined','undefined','undefined','EACCES','ERR_UNSUPPORTED_OPERATION','ERR_UNSUPPORTED_OPERATION','ERR_UNSUPPORTED_OPERATION'])
  expect(results.files).not.toContain('/denied')
  expect(results.timeout.exitCode).not.toBe(0)
  expect(results.timeout.stdout).not.toContain('caught outer deadline')
  expect(results.heap.exitCode).not.toBe(0)
  expect(results.recovery.exitCode).toBe(0)
})
