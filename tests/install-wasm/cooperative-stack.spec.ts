import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'

const resumeSemantics={
  'generator delegation and finally':`const log=[];function* child(){try{log.push('child');yield 1;yield 2}finally{log.push('child-finally')}}function* outer(){try{return yield* child()}finally{log.push('outer-finally')}}const g=outer();log.push(g.next(),g.return(9),g.next());return log`,
  'generator throw and reentry':`const log=[];let g;function* body(){try{try{g.next()}catch(e){log.push(e.name)}yield 1}catch(e){log.push(e.message);yield 2}finally{log.push('finally')}}g=body();log.push(g.next(),g.throw(new Error('injected')),g.next());return log`,
  'async synchronous prefix and finally':`const log=[];async function child(){log.push('child-prefix');await 0;log.push('child-resume');throw new Error('injected')}async function outer(){try{log.push('outer-prefix');await child()}catch(e){log.push(e.message)}finally{log.push('finally')}}const p=outer();log.push('caller');await p;log.push('done');return log`,
  'async generator queued requests':`const log=[];async function* body(){try{log.push('prefix');yield await Promise.resolve(1);log.push('resume');yield 2}finally{log.push('finally')}}const g=body();const a=g.next(),b=g.next(),c=g.return(9);log.push('queued');log.push(await a,await b,await c,await g.next());return log`,
  'completed async generator queued return':`const log=[];async function* body(){}const g=body();await g.next();let settle;const value=new Promise(resolve=>{settle=resolve});const a=g.return(value),b=g.next(),c=g.throw('queued-error');const results=Promise.allSettled([a,b,c]);log.push('queued');settle(9);log.push(...await results);return log`,
  'completed async generator rejected return':`async function* body(){}const g=body();await g.next();let reject;const value=new Promise((_,r)=>{reject=r});const a=g.return(value),b=g.next(),c=g.return(12);const results=Promise.allSettled([a,b,c]);reject('return-error');return await results`,
  'completed async generator backlog':`async function* body(){}const g=body();await g.next();let release;const gate=new Promise(r=>{release=r});const pending=[g.return(gate)];for(let i=0;i<256;i++)pending.push(i%3===0?g.return(i):i%3===1?g.next():g.throw(i));const result=Promise.allSettled(pending);release(42);return await result`,
  'async generator yielding finally':`const log=[];async function* body(){try{yield 1}finally{log.push('finally-enter');yield 2;await 0;log.push('finally-exit')}}const g=body();log.push(await g.next());const a=g.return(9),b=g.next(),c=g.next();log.push(...await Promise.allSettled([a,b,c]));return log`,
  'async generator awaiting rejection backlog':`let reject;const gate=new Promise((_,r)=>{reject=r});async function* body(){try{await gate;yield 1}finally{yield 2}}const g=body();const a=g.next(),b=g.next(),c=g.return(9),d=g.next();const result=Promise.allSettled([a,b,c,d]);reject('await-error');return await result`,
  'completed async generator thenable reentry':`const log=[];async function* body(){}const g=body();await g.next();let nested;const a=g.return({then(resolve){log.push('then');nested=g.next();resolve(8)}});const b=g.next();log.push(await a,await b,await nested);return log`,
}

const cases={
  generator:`function* recur(n){depth=n;return recur(n+1).next().value}recur(0).next()`,
  'generator-call':`function* recur(n){depth=n;return recur.call(null,n+1).next().value}recur(0).next()`,
  async:`async function recur(n){depth=n;return 1+await recur(n+1)}await recur(0)`,
  'async-generator':`async function* recur(n){depth=n;return (await recur(n+1).next()).value}await recur(0).next()`,
}
const cooperative=process.env.COOPERATIVE_STACK_SYNC!=='1'
const suffix=(process.env.COOPERATIVE_STACK_OPT==='O2'?'-o2':'')+(process.env.COOPERATIVE_STACK_SPLIT==='1'?'-split-native':'')+(process.env.COOPERATIVE_GENERATOR_QUEUE==='1'?'-generator-queue':'')
test.beforeEach(async({context},info)=>{
  if(cooperative&&suffix)await context.route('**/quickjs-als-asyncify-wasm-cooperative/**',route=>route.continue({url:route.request().url().replace('-wasm-cooperative/','-wasm'+suffix+'-cooperative/')}))
  await info.attach('engine-build.json',{body:readFileSync(cooperative?'public/quickjs-als-asyncify-wasm'+suffix+'-cooperative/build.json':'public/quickjs-als-wasm/build.json'),contentType:'application/json'})
})

test('generator resume semantics match Node',async({page},info)=>{
  const expected=await Promise.all(Object.entries(resumeSemantics).map(async([name,code])=>({name,value:JSON.stringify(await runInNewContext(`(async()=>{${code}})()`))})))
  await page.goto('/sandbox.html')
  const actual=await page.evaluate(async({cases,cooperative})=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{cooperative})
    try{
      const rows=[]
      for(const [name,code] of Object.entries(cases)){
        const result=await kernel.execute(`console.log(JSON.stringify(await(async()=>{${code}})()))`,{guestWasm:true,timeoutMs:5000})
        rows.push({name,value:result.stdout.trim(),exitCode:result.exitCode,stderr:result.stderr})
      }
      return rows
    }finally{kernel.close()}
  },{cases:resumeSemantics,cooperative})
  await info.attach('resume-semantics.json',{body:JSON.stringify({expected,actual}),contentType:'application/json'})
  for(const row of actual){expect(row.exitCode,JSON.stringify(row)).toBe(0);expect(row.stderr).toBe('')}
  expect(actual.map(({name,value})=>({name,value}))).toEqual(expected)
})

test('async generator error construction boundary',async({page},info)=>{
  await page.goto('/sandbox.html')
  const rows=await page.evaluate(async({cooperative})=>{
    const rows=[]
    for(const mode of ['return','throw-value','throw-error'])for(const limit of [40,48,52,56,60]){
      const kernel=new window.sandboxLab.WorkerKernel({},{cooperative})
      try{
        const terminal=mode==='return'?'return 42':mode==='throw-value'?"throw 'sentinel'":"throw new Error('sentinel')"
        const code=`let depth=0;async function* recur(n){depth=n;if(n===${limit}){${terminal}}return(await recur(n+1).next()).value}try{const result=await recur(0).next();console.log(JSON.stringify({depth,value:result.value}))}catch(error){console.log(JSON.stringify({depth,error:String(error)}))}`
        const result=await kernel.execute(code,{guestWasm:true,timeoutMs:5000})
        rows.push({mode,limit,exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr.slice(0,600),cleanupFailure:result.stderr.includes('Kernel cleanup failed')})
      }finally{kernel.close()}
    }
    return rows
  },{cooperative})
  await info.attach('error-construction-boundary.json',{body:JSON.stringify(rows),contentType:'application/json'})
  console.log(JSON.stringify(rows))
  expect(rows.filter(row=>row.exitCode!==0),JSON.stringify(rows)).toEqual([])
  for(const row of rows){
    const value=JSON.parse(row.stdout)
    expect(value.depth).toBe(row.limit)
    if(row.mode==='return')expect(value.value).toBe(42)
    else expect(value.error).toContain('sentinel')
  }
})

test('generator finite-depth boundary',async({page},info)=>{
  await page.goto('/sandbox.html')
  const rows=await page.evaluate(async({cases,cooperative})=>{
    const rows=[]
    for(const [name,code] of Object.entries(cases))for(const limit of [4,8,16,24,32,48,52,56,60,64,72]){
      const kernel=new window.sandboxLab.WorkerKernel({},{cooperative})
      try{
        const bounded=code.replace('depth=n;',`depth=n;if(n===${limit})return 42;`).replace('1+await','await').replace('}recur(0)','}return recur(0)').replace('}await recur(0)','}return await recur(0)')
        const result=await kernel.execute(`let depth=0;try{const value=await(async()=>{${bounded}})();console.log(JSON.stringify({depth,value:value?.value??value}))}catch(error){console.log(JSON.stringify({depth,error:String(error)}))}`,{guestWasm:true})
        rows.push({name,limit,exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr.slice(0,300),cleanupFailure:result.stderr.includes('Kernel cleanup failed')})
      }catch(error){rows.push({name,limit,exitCode:1,stdout:'',stderr:String(error),cleanupFailure:false})}
      finally{kernel.close()}
    }
    return rows
  },{cases,cooperative})
  await info.attach('finite-depth.json',{body:JSON.stringify(rows),contentType:'application/json'})
  console.log(JSON.stringify(rows))
  expect(rows.filter(row=>row.exitCode!==0),JSON.stringify(rows)).toEqual([])
  for(const row of rows){
    const value=JSON.parse(row.stdout)
    if(row.limit<=48||value.value===42)expect(value).toMatchObject({value:42})
    else expect(value.error).toMatch(/stack overflow/i)
  }
})

for(const [name,code] of Object.entries(cases))test((cooperative?'cooperative':'synchronous')+' stack recovery '+name,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({code,cooperative})=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{cooperative})
    try{
      const runs=[]
      for(let i=0;i<3;i++)runs.push(await kernel.execute(`let depth=0,caught='';try{${code}}catch(error){caught=String(error)}console.log(JSON.stringify({depth,caught,answer:42}));`,{guestWasm:true,timeoutMs:5000}))
      return {runs,recovery:await kernel.execute('console.log(42)',{guestWasm:true})}
    }catch(error){return {error:String(error)}}finally{kernel.close()}
  },{code,cooperative})
  await info.attach('cooperative-stack.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.error,JSON.stringify(result)).toBeUndefined()
  for(const run of result.runs??[]){
    expect(run.exitCode,JSON.stringify(run)).toBe(0)
    const value=JSON.parse(run.stdout)
    expect(value.depth).toBeGreaterThan(0)
    expect(value.caught).toMatch(/stack overflow/i)
    expect(value.answer).toBe(42)
  }
  expect(result.recovery?.exitCode,JSON.stringify(result)).toBe(0)
  expect(result.recovery?.stdout.trim()).toBe('42')
})
