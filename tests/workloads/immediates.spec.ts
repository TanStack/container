import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const cases:Record<string,string>={
  'FIFO, cancellation, nested callbacks, and intervening microtasks':`
    const seen=[];
    setImmediate(function(value){seen.push([value,this.hasRef()]);clearImmediate(canceled);queueMicrotask(()=>seen.push('microtask'));setImmediate(()=>{seen.push('nested');console.log(JSON.stringify(seen))})},'first');
    const canceled=setImmediate(()=>seen.push('canceled'));setImmediate(()=>seen.push('third'));seen.push('sync');`,
  'independent callbacks retain their creation contexts':`
    import {AsyncLocalStorage} from 'node:async_hooks';const als=new AsyncLocalStorage(),seen=[];
    await Promise.all(['a','b'].map(value=>als.run(value,()=>new Promise(resolve=>setImmediate(async()=>{seen.push(als.getStore());await 0;seen.push(als.getStore());resolve()})))));
    console.log(JSON.stringify([seen,als.getStore()]));`,
  'reference state and unreferenced shutdown':`
    // An unreferenced callback may run while Node still has pipe I/O pending.
    // It must not keep the process alive on its own, even if it requeues itself.
    function again(){setImmediate(again).unref()}
    const handle=setImmediate(again),seen=[handle.hasRef(),handle.unref()===handle,handle.hasRef(),handle.ref()===handle,handle.hasRef()];
    handle.unref();console.log(JSON.stringify(seen));`,
  'timers exports, cleared handles, and argument validation':`
    import timers,{setImmediate as immediate,clearImmediate as clear} from 'node:timers';const seen=[immediate===setImmediate,clear===clearImmediate,timers.setImmediate===setImmediate];
    const handle=immediate(()=>console.log('unexpected'));clear(handle);handle.ref();seen.push(handle.hasRef());clear(undefined);clear(null);clear(handle);
    try{immediate(null)}catch(e){seen.push(e.name,e.code)}console.log(JSON.stringify(seen));`,
}
for(const [name,source] of Object.entries(cases))for(const mode of ['modules','bundle'] as const){
  test('Node immediates | '+mode+' | '+name,async({page})=>{
    const node=spawnSync(process.execPath,['--input-type=module'],{input:source,encoding:'utf8',timeout:10000})
    expect(node.status,node.stderr).toBe(0)
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({source,mode})=>{
      const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':source})
      try{return await (mode==='modules'?kernel.runModule('/entry.mjs'):kernel.run('/entry.mjs'))}finally{kernel.close()}
    },{source,mode})
    expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(node.stdout);expect(result.stderr).toBe(node.stderr)
  })
}

test('Node immediates | quota, callback errors, deadlines, and recovery',async({page})=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel(),results=[]
    try{
      for(const source of [
        `for(let i=0;i<129;i++)setImmediate(()=>{})`,
        `setImmediate(()=>{throw Error('immediate callback failed')})`,
        `function again(){setImmediate(again)}again()`,
      ]){
        results.push(await kernel.execute(source,{timeoutMs:200}));results.push(await kernel.execute('console.log("recovered")'))
      }
      results.push(await kernel.execute(`for(let i=0;i<1024;i++)clearImmediate(setImmediate(()=>{throw Error('canceled')}));console.log('closed')`))
      return results
    }finally{kernel.close()}
  })
  for(const [index,error] of ['Too many pending immediates','immediate callback failed','Execution timed out'].entries()){
    expect(results[index*2].exitCode).toBe(1);expect(results[index*2].stderr).toContain(error)
    expect(results[index*2+1].exitCode).toBe(0);expect(results[index*2+1].stdout).toBe('recovered\n')
  }
  expect(results[6].exitCode,results[6].stderr).toBe(0);expect(results[6].stdout).toBe('closed\n')
})
