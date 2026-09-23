import {test,expect} from '@playwright/test'
import {AsyncLocalStorage} from 'node:async_hooks'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'

const alsCases=JSON.parse(readFileSync('src/feasibility/als-cases.json','utf8')) as {id:string,code:string}[]

for(const callback of ['immediate','queued timer'])test('session '+callback+' callbacks each receive a turn budget',async({page},info)=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async callback=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{cooperative:true})
    try{
      await kernel.execute('console.log("warm")',{guestWasm:true})
      await kernel.writeText('/turns.mjs',callback==='immediate'?`for(let i=0;i<8;i++){await new Promise(resolve=>setImmediate(resolve));const end=performance.now()+90;while(performance.now()<end){};}console.log('COMPLETE')`:`for(let i=0;i<8;i++){const next=new Promise(resolve=>setTimeout(resolve,1));const end=performance.now()+90;while(performance.now()<end){};await next;}console.log('COMPLETE')`)
      const results=[]
      for(const lifetime of ['session','bounded'] as const){
        const child=await kernel.spawn('node',['/turns.mjs'],{guestWasm:true,lifetime,timeoutMs:500})
        const execution=await child.wait()
        while(await child.next()){}
        await child.dispose()
        results.push({lifetime,execution})
      }
      return results
    }finally{kernel.close()}
  },callback)
  await info.attach('immediate-turn-budgets.json',{body:JSON.stringify(results),contentType:'application/json'})
  expect(results[0].execution.exitCode,JSON.stringify(results)).toBe(0)
  expect(results[0].execution.stdout).toContain('COMPLETE')
  expect(results[1].execution.exitCode).not.toBe(0)
})

test.beforeEach(async({context},info)=>{
  if(process.env.TERMINATION_COOPERATIVE==='1'){
    for(const wasm of ['', '-wasm']){
      const name='quickjs-als-asyncify'+wasm+'-'+(wasm?(process.env.COOPERATIVE_WASM_OPT??'o2'):'o2')+'-generator-queue-yield-profile'+(wasm?'-poll4096':'')+'-cooperative'+(wasm&&process.env.COOPERATIVE_WASM_BATCH?'-batch'+process.env.COOPERATIVE_WASM_BATCH:'')+(wasm&&process.env.COOPERATIVE_ASSIGNMENTS==='1'?'-assignments':'')+(wasm&&process.env.COOPERATIVE_UNWIND==='1'?'-unwind':'')+(wasm&&process.env.COOPERATIVE_HEAP_LOOPS==='1'?'-heap-loops':'')
      await info.attach('cooperative-engine'+wasm+'.json',{body:readFileSync('public/'+name+'/build.json'),contentType:'application/json'})
    }
    return
  }
  if(process.env.COOPERATIVE_GENERATOR_QUEUE!=='1')return
  for(const wasm of ['', '-wasm']){
    const base='quickjs-als-asyncify'+wasm
    const suffix='-generator-queue'+(process.env.COOPERATIVE_YIELD_PROFILE==='1'?'-yield-profile':'')+(wasm&&process.env.COOPERATIVE_WASM_POLL==='4096'?'-poll4096':'')
    await context.route('**/'+base+'-cooperative/**',route=>route.continue({url:route.request().url().replace(base+'-cooperative/',base+suffix+'-cooperative/')}))
    await info.attach('generator-queue'+wasm+'-build.json',{body:readFileSync('public/'+base+suffix+'-cooperative/build.json'),contentType:'application/json'})
  }
})

test('cooperative kernel expires a held engine load without a kill',async({page,context},info)=>{
  let requested=false,release!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve})
  await context.route('**/quickjs-als-asyncify-wasm-cooperative/engine.wasm',async route=>{requested=true;await held;await route.continue()})
  try{
    await page.goto('/sandbox.html')
    await page.evaluate(async()=>{
      const kernel=new window.sandboxLab.WorkerKernel({},{cooperative:true})
      const child=await kernel.spawn('node',['-e',"require('node:fs').writeFileSync('/unexpected','ran')"],{guestWasm:true,timeoutMs:500})
      ;(window as any).startupDeadlineProbe={kernel,child}
    })
    await expect.poll(()=>requested,{timeout:10000}).toBe(true)
    const expired=await page.evaluate(async()=>{
      const {child}=(window as any).startupDeadlineProbe
      let timer:ReturnType<typeof setTimeout>|undefined
      try{return await Promise.race([child.wait(),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),1500)})])}
      finally{clearTimeout(timer)}
    })
    release()
    const recovery=await page.evaluate(async()=>{
      const {kernel,child}=(window as any).startupDeadlineProbe
      await child.wait();while(await child.next()){};await child.dispose()
      let ran=false;try{await kernel.readText('/unexpected');ran=true}catch{}
      return {ran,result:await kernel.execute('console.log(42)',{guestWasm:true})}
    })
    await info.attach('startup-deadline.json',{body:JSON.stringify({expired,recovery}),contentType:'application/json'})
    expect(expired,JSON.stringify({expired,recovery})).not.toBeNull()
    expect(expired?.exitCode).not.toBe(0)
    expect(expired?.stderr).toContain('Engine startup timed out')
    expect(expired?.signal).toBeNull()
    expect(recovery.ran).toBe(false)
    expect(recovery.result.exitCode,JSON.stringify(recovery)).toBe(0)
    expect(recovery.result.stdout.trim()).toBe('42')
  }finally{release();await page.evaluate(()=>{(window as any).startupDeadlineProbe?.kernel.close();delete (window as any).startupDeadlineProbe}).catch(()=>{})}
})

for(const failure of ['http','invalid-wasm'])test('cooperative kernel retries failed engine '+failure,async({page,context},info)=>{
  let requests=0
  await context.route('**/quickjs-als-asyncify-wasm-cooperative/engine.wasm',async route=>{
    requests++
    if(requests===1)await route.fulfill(failure==='http'
      ?{status:503,body:'Unavailable'}
      :{status:200,contentType:'application/wasm',body:'not wasm'})
    else await route.continue()
  })
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{cooperative:true})
    try{
      const failed=await kernel.spawn('node',['-e',"require('node:fs').writeFileSync('/unexpected','ran')"],{guestWasm:true})
      const first=await failed.wait();while(await failed.next()){};await failed.dispose()
      let ran=false;try{await kernel.readText('/unexpected');ran=true}catch{}
      const recovered=await kernel.execute('console.log(42)',{guestWasm:true})
      const cached=await kernel.execute('console.log(43)',{guestWasm:true})
      return {first,ran,recovered,cached}
    }finally{kernel.close()}
  })
  await info.attach('engine-retry.json',{body:JSON.stringify({requests,...result}),contentType:'application/json'})
  expect(result.first.exitCode).not.toBe(0)
  expect(result.first.stderr).toContain(failure==='http'?'Engine fetch failed: 503':'CompileError')
  expect(result.ran).toBe(false)
  expect(result.recovered.exitCode,JSON.stringify(result)).toBe(0)
  expect(result.recovered.stdout.trim()).toBe('42')
  expect(result.cached.exitCode,JSON.stringify(result)).toBe(0)
  expect(result.cached.stdout.trim()).toBe('43')
  expect(requests).toBe(2)
})

for(const shared of [false,true])test('cooperative kernel cancels while engine download is held'+(shared?' with another waiter':''),async({page,context},info)=>{
  let requested=false,requests=0,release!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve})
  await context.route('**/quickjs-als-asyncify-wasm-cooperative/engine.wasm',async route=>{
    requested=true;requests++;await held;await route.continue()
  })
  try{
    await page.goto('/sandbox.html')
    await page.evaluate(async shared=>{
      const kernel=new window.sandboxLab.WorkerKernel({},{cooperative:true})
      const child=await kernel.spawn('node',['-e',"require('node:fs').writeFileSync('/unexpected','ran')"],{guestWasm:true,timeoutMs:5000})
      const survivor=shared?await kernel.spawn('node',['-e','console.log(43)'],{guestWasm:true,timeoutMs:5000}):undefined
      ;(window as any).coldLoadProbe={kernel,child,survivor}
    },shared)
    await expect.poll(()=>requested,{timeout:10000}).toBe(true)
    const cancellation=await page.evaluate(async()=>{
      const {child}=(window as any).coldLoadProbe
      const started=performance.now();await child.kill('SIGKILL')
      let timer:ReturnType<typeof setTimeout>|undefined
      try{return await Promise.race([
        child.wait().then((result:any)=>({completed:true,elapsedMs:performance.now()-started,signal:result.signal})),
        new Promise<{completed:boolean;elapsedMs:number;signal:null}>(resolve=>{timer=setTimeout(()=>resolve({completed:false,elapsedMs:performance.now()-started,signal:null}),2000)}),
      ])}finally{clearTimeout(timer)}
    })
    release()
    const recovery=await page.evaluate(async()=>{
      const {kernel,child,survivor}=(window as any).coldLoadProbe
      await child.wait();while(await child.next()){};await child.dispose()
      let ran=false;try{await kernel.readText('/unexpected');ran=true}catch{}
      const survived=survivor?await survivor.wait():undefined
      if(survivor){while(await survivor.next()){};await survivor.dispose()}
      return {ran,survived,execution:await kernel.execute('console.log(42)',{guestWasm:true})}
    })
    await info.attach('cold-load-cancellation.json',{body:JSON.stringify({cancellation,recovery}),contentType:'application/json'})
    expect(cancellation.completed,JSON.stringify(cancellation)).toBe(true)
    expect(cancellation.signal).toBe('SIGKILL')
    expect(recovery.ran).toBe(false)
    expect(recovery.execution.exitCode,JSON.stringify(recovery)).toBe(0)
    expect(recovery.execution.stdout.trim()).toBe('42')
    if(shared){expect(recovery.survived?.exitCode,JSON.stringify(recovery)).toBe(0);expect(recovery.survived?.stdout.trim()).toBe('43')}
    expect(requests).toBe(shared?1:2)
  }finally{
    release();await page.evaluate(()=>{(window as any).coldLoadProbe?.kernel.close();delete (window as any).coldLoadProbe}).catch(()=>{})
  }
})

test('cooperative kernel survives 66 CPU cancellation cycles',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{cooperative:true,maxBytes:128*1024*1024})
    const cycles=[]
    try{
      for(let cycle=0;cycle<66;cycle++){
        await kernel.writeText('/entered','no')
        await kernel.writeText('/loop.mjs',`import {writeFileSync} from 'node:fs';globalThis.retained=new Uint8Array(8*1024*1024);setTimeout(()=>{writeFileSync('/entered','yes');while(true){}},10)`)
        const child=await kernel.spawn('node',['/loop.mjs'],{guestWasm:true,maxBytes:128*1024*1024,timeoutMs:5000,diagnostics:true})
        const drain=(async()=>{while(await child.next()){} })()
        const deadline=Date.now()+5000
        while(await kernel.readText('/entered')!=='yes'){
          if(Date.now()>deadline){
            await child.kill('SIGKILL');const stopped=await child.wait();await drain;await child.dispose()
            throw Error('Cycle did not enter CPU loop: '+JSON.stringify({cycle,stopped}))
          }
          await new Promise(resolve=>setTimeout(resolve,5))
        }
        const started=performance.now(),killed=await child.kill('SIGKILL')
        const stopped=await child.wait();await drain;await child.dispose()
        const killMs=performance.now()-started
        if(!killed||stopped.signal!=='SIGKILL'||killMs>2000)throw Error('Cancellation failed: '+JSON.stringify({cycle,killed,stopped,killMs}))
        cycles.push({cycle,killMs,wasmHeapBytes:stopped.wasmHeapBytes,startup:stopped.diagnostics?.startup})
      }
      const recovery=await kernel.execute('console.log(42)',{guestWasm:true})
      return {cycles,recovery}
    }catch(error){return {cycles,error:String(error)}}finally{kernel.close()}
  })
  await info.attach('cooperative-cycles.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.error,JSON.stringify(result)).toBeUndefined()
  expect(result.cycles).toHaveLength(66)
  expect(result.recovery?.exitCode,JSON.stringify(result.recovery)).toBe(0)
  expect(result.recovery?.stdout.trim()).toBe('42')
})

for(const guestWasm of [false,true])test('cooperative kernel preserves ALS '+(guestWasm?'with WASM':'without WASM'),async({page},info)=>{
  const cases=[]
  for(const fixture of alsCases)cases.push({...fixture,expected:JSON.stringify(await runInNewContext(`(async()=>{${fixture.code}})()`,{ALS:AsyncLocalStorage}))})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({cases,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{cooperative:true})
    try{
      const comparisons=[]
      for(const fixture of cases){
        const execution=await kernel.execute(`const ALS=__webContainerHost.AsyncLocalStorage;console.log(JSON.stringify(await(async()=>{${fixture.code}})()));`,{guestWasm,timeoutMs:10000})
        comparisons.push({id:fixture.id,expected:fixture.expected,actual:execution.stdout.trim(),exitCode:execution.exitCode,stderr:execution.stderr})
      }
      await kernel.writeText('/overlap.mjs',`import {AsyncLocalStorage} from 'node:async_hooks';import {writeFileSync,existsSync} from 'node:fs';
        const als=new AsyncLocalStorage();const label=process.argv[2];
        await Promise.all(['a','b'].map(branch=>als.run(label+branch,async()=>{
          const expected=label+branch;
          for(let turn=0;turn<3;turn++){
            const end=Date.now()+40;while(Date.now()<end){if(als.getStore()!==expected)throw Error('Context lost during CPU work')}
            writeFileSync('/ready-'+expected,'yes');
            while(!existsSync('/release'))await new Promise(resolve=>setTimeout(resolve,5));
            await new Promise(resolve=>setTimeout(resolve,5));
            if(als.getStore()!==expected)throw Error('Context lost after suspension');
          }
        })));
        if(als.getStore()!==undefined)throw Error('Context leaked outside run');console.log('ALS_OK '+label);`)
      const children=await Promise.all(['one','two'].map(label=>kernel.spawn('node',['/overlap.mjs',label],{guestWasm,timeoutMs:15000})))
      const drains=children.map(async child=>{while(await child.next()){} })
      const deadline=Date.now()+10000
      for(const label of ['onea','oneb','twoa','twob']){
        for(;;){
          try{if(await kernel.readText('/ready-'+label)==='yes')break}catch{}
          if(Date.now()>deadline)throw Error('Concurrent ALS branch did not reach barrier: '+label)
          await new Promise(resolve=>setTimeout(resolve,10))
        }
      }
      await kernel.writeText('/release','yes')
      const processes=await Promise.all(children.map(child=>child.wait()))
      await Promise.all(drains);await Promise.all(children.map(child=>child.dispose()))
      return {comparisons,processes}
    }finally{kernel.close()}
  },{cases,guestWasm})
  await info.attach('cooperative-als.json',{body:JSON.stringify(result),contentType:'application/json'})
  for(const row of result.comparisons){expect(row.exitCode,JSON.stringify(row)).toBe(0);expect(row.actual,row.id).toBe(row.expected)}
  for(const process of result.processes)expect(process.exitCode,JSON.stringify(process)).toBe(0)
})

for(const wasmLoop of [false,true])test('cooperative kernel automatically expires '+(wasmLoop?'WASM':'JS')+' CPU work',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async wasmLoop=>{
    const loop=wasmLoop?'new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,8,1,4,108,111,111,112,0,0,10,9,1,7,0,3,64,12,0,11,11]))).exports.loop()':'while(true){}'
    const kernel=new window.sandboxLab.WorkerKernel({},{cooperative:true})
    try{
      const warm=await kernel.execute('console.log("warm")',{guestWasm:true,timeoutMs:5000})
      if(warm.exitCode!==0)throw Error(warm.stderr)
      await kernel.writeText('/deadline.mjs',`import {writeFileSync} from 'node:fs';writeFileSync('/saved','41');setTimeout(()=>{${loop}},0);`)
      const started=performance.now()
      const execution=await kernel.runModule('/deadline.mjs',{guestWasm:true,timeoutMs:1000})
      const elapsedMs=performance.now()-started
      const saved=await kernel.readText('/saved')
      const recovery=await kernel.execute('console.log(42)',{guestWasm:true,timeoutMs:5000})
      return {execution,elapsedMs,saved,recovery}
    }finally{kernel.close()}
  },wasmLoop)
  await info.attach('automatic-deadline.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.execution.exitCode).not.toBe(0)
  expect(result.execution.stderr).toMatch(/timed out|interrupted/i)
  expect(result.elapsedMs).toBeLessThan(3000)
  expect(result.saved).toBe('41')
  expect(result.recovery.exitCode,result.recovery.stderr).toBe(0)
  expect(result.recovery.stdout.trim()).toBe('42')
})

for(const wasmLoop of [false,true])test('cooperative kernel cancels '+(wasmLoop?'WASM':'JS')+' CPU work and preserves workspace',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async wasmLoop=>{
    const loop=wasmLoop?'new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,8,1,4,108,111,111,112,0,0,10,9,1,7,0,3,64,12,0,11,11]))).exports.loop()':'while(true){}'
    const kernel=new window.sandboxLab.WorkerKernel({
      '/loop.mjs':`import {writeFileSync} from 'node:fs';writeFileSync('/saved','41');console.log('READY');setTimeout(()=>{writeFileSync('/entered','yes');${loop}},100);`,
    },{cooperative:true})
    try{
      const child=await kernel.spawn('node',['/loop.mjs'],{guestWasm:true,webAPIs:true,timeoutMs:10000})
      const drain=(async()=>{while(await child.next()){} })()
      for(let n=0;;n++){
        try{if(await kernel.readText('/entered')==='yes')break}catch{}
        if(n>500)throw Error('Child did not start')
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      const started=performance.now(),killed=await child.kill('SIGKILL')
      const termination=await child.wait();await drain;await child.dispose()
      const killMs=performance.now()-started
      const recovery=await kernel.execute('console.log(6*7)',{guestWasm:true,timeoutMs:5000})
      return {killed,killMs,termination,recovery,saved:await kernel.readText('/saved')}
    }finally{kernel.close()}
  },wasmLoop)
  await info.attach('cooperative-kernel.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.killed).toBe(true)
  expect(result.killMs).toBeLessThan(2000)
  expect(result.termination.signal).toBe('SIGKILL')
  expect(result.recovery.exitCode,JSON.stringify(result)).toBe(0)
  expect(result.recovery.stdout.trim()).toBe('42')
  expect(result.saved).toBe('41')
})
