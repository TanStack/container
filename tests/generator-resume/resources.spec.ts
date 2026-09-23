import {test,expect} from '@playwright/test'
import {resourceServer} from './resource-server'

const workerSource=`self.onmessage=async({data})=>{
  let runtime,context,reply;
  try{
    const base=new URL('./',self.location.href);
    const metadata=await(await fetch(new URL('build.json',base))).json();
    if(metadata.generatorResume?.scope!=='direct intrinsic generator calls'||metadata.interpreterFrames?.limit!==4096)throw Error('Unexpected candidate limits');
    const bytes=await(await fetch(new URL('engine.wasm',base))).arrayBuffer();
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==data.wasmSHA256||hash!==metadata.wasmSha256)throw Error('Candidate WASM hash mismatch');
    const wrapper=await import(new URL('core.mjs',base));
    const factory=(await import(new URL('engine.mjs',base))).default;
    const {QuickJSFFI}=await import(new URL('ffi.mjs',base));
    const module=await wrapper.newQuickJSWASMModuleFromVariant({type:'sync',importFFI:async()=>QuickJSFFI,importModuleLoader:async()=>()=>factory({wasmBinary:bytes})});
    runtime=module.newRuntime();runtime.setMemoryLimit(data.memoryBytes);runtime.setMaxStackSize(512*1024);
    let deadline=performance.now()+5000;runtime.setInterruptHandler(()=>performance.now()>deadline);
    context=runtime.newContext();
    const evaluate=source=>{deadline=performance.now()+5000;const result=context.evalCode(source,'generator-resources.js');try{return result.error?{error:context.dump(result.error)}:{value:context.dump(result.value)}}finally{result.dispose()}};
    const rows=[];
    for(const source of data.sources){
      const actual=evaluate(source);
      const unwind=evaluate('JSON.stringify({entered,finalized})');
      const recovery=evaluate('6*7');
      const generatorRecovery=evaluate('(function*(){yield 42})().next().value');
      rows.push({actual,unwind,recovery,generatorRecovery});
    }
    context.dispose();context=runtime.newContext();
    const fresh=evaluate('6*7');
    const freshGenerator=evaluate('(function*(){return 42})().next().value');
    reply={rows,fresh,freshGenerator,wasmSHA256:hash,memoryBytes:data.memoryBytes};
  }catch(error){reply={error:String(error)}}
  finally{
    try{context?.dispose();runtime?.dispose()}catch(error){reply={...reply,cleanupError:String(error)}}
    self.postMessage(reply);
  }
};`
let host:Awaited<ReturnType<typeof resourceServer>>
test.beforeAll(async()=>{host=await resourceServer(workerSource)})
test.afterAll(async()=>{await host.close()})

const chain=(depth:number,leaf='return 42')=>`var entered=0,finalized=0;
function* nested(depth){entered++;try{if(depth)return nested(depth-1).next().value;${leaf}}finally{finalized++}}
nested(${depth}).next().value`
const cases=[
  {name:'4096 direct generator continuations succeed, the next is rejected and all finally blocks unwind',memoryBytes:64*1024*1024,
    sources:[chain(4095),chain(4096),chain(4095)],
    expected:[{entered:4096,success:true},{entered:4096,success:false},{entered:4096,success:true}],
    error:/stack overflow/i},
  {name:'explicit 8 MiB guest ceiling rejects a 16 MiB allocation and unwinds suspended generators',memoryBytes:8*1024*1024,
    sources:[chain(15,'return new Uint8Array(16*1024*1024).length'),chain(15),chain(15,'return new Uint8Array(16*1024*1024).length')],
    expected:[{entered:16,success:false},{entered:16,success:true},{entered:16,success:false}],
    error:/out of memory/i},
]
for(const item of cases)test(item.name,async({page},info)=>{
  expect(host.metadata.generatorResume?.scope).toBe('direct intrinsic generator calls')
  expect(host.metadata.generatorResume.stageSHA256).toBe(host.stageSHA256)
  expect(host.metadata.interpreterFrames?.limit).toBe(4096)
  expect(host.metadata.wasmSha256).toBe(host.wasmSHA256)
  await page.goto(host.url)
  const actual=await page.evaluate(data=>new Promise<any>((done,reject)=>{
    const worker=new Worker('/resource.worker.js',{type:'module'})
    const timer=setTimeout(()=>{worker.terminate();reject(Error('Resource worker exceeded 20 seconds'))},20000)
    worker.onmessage=event=>{clearTimeout(timer);worker.terminate();done(event.data)}
    worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(Error(event.message))}
    worker.postMessage(data)
  }),{sources:item.sources,memoryBytes:item.memoryBytes,wasmSHA256:host.wasmSHA256})
  await info.attach('generator-resources.json',{body:JSON.stringify({name:item.name,metadata:host.metadata,actual}),contentType:'application/json'})
  expect(actual.error).toBeUndefined()
  expect(actual.cleanupError).toBeUndefined()
  expect(actual.wasmSHA256).toBe(host.wasmSHA256)
  expect(actual.rows).toHaveLength(item.expected.length)
  for(const [index,expected] of item.expected.entries()){
    const row=actual.rows[index]
    expect(JSON.parse(row.unwind.value)).toEqual({entered:expected.entered,finalized:expected.entered})
    if(expected.success)expect(row.actual).toEqual({value:42})
    else expect(row.actual.error?.message).toMatch(item.error)
    expect(row.recovery).toEqual({value:42})
    expect(row.generatorRecovery).toEqual({value:42})
  }
  expect(actual.fresh).toEqual({value:42})
  expect(actual.freshGenerator).toEqual({value:42})
})
