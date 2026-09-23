import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

// Instrumented diagnostic, not an unchanged-package acceptance result.
test('diagnostic Rolldown worker startup trace',async({page},info)=>{
  const root=realpathSync(process.env.SDK_OUTPUT)
  const diagnosticRoot=process.env.WASM_MEMORY_DIAGNOSTIC_ENGINE?realpathSync(process.env.WASM_MEMORY_DIAGNOSTIC_ENGINE):undefined
  const diagnosticBuild=diagnosticRoot?JSON.parse(readFileSync(resolve(diagnosticRoot,'build.json'),'utf8')):undefined
  const growthReservation=process.env.WASM_GROWTH_RESERVATION==='1'
  const snapshot=JSON.stringify(await collectInstalledClosure(resolve('fixtures/compiler-wasi'),['@rolldown/binding-wasm32-wasi']))
  const server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside package')
      const enginePrefix='/sdk/runtime/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage/'
      const engineFile=path.startsWith(enginePrefix)?path.slice(enginePrefix.length):''
      const overlay=diagnosticRoot&&['engine.mjs','engine.wasm','core.mjs','ffi.mjs'].includes(engineFile)
      const servingRoot=overlay?diagnosticRoot:root
      const file=realpathSync(resolve(servingRoot,overlay?engineFile:decodeURIComponent(path.slice(5))))
      if(!file.startsWith(servingRoot+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(()=>Boolean(window.sdk))
    const source=`
const wt=require('node:worker_threads');
const OriginalWorker=wt.Worker;
let sequence=0;
const trace=(type,details)=>console.log('WORKER_TRACE '+JSON.stringify({sequence:++sequence,type,...details}));
const describe=error=>({name:error?.name,message:error?.message,code:error?.code,stack:error?.stack});
const originalSend=OriginalWorker.prototype.postMessage,originalEmit=OriginalWorker.prototype.emit;
OriginalWorker.prototype.postMessage=function(message,...args){
 trace('postMessage',{threadId:this.threadId,messageType:message?.__emnapi__?.type});
 try{return originalSend.call(this,message,...args)}catch(error){trace('postMessage-error',{threadId:this.threadId,error:describe(error)});throw error}
};
OriginalWorker.prototype.emit=function(type,...args){
 if(type==='error')trace('worker-error',{threadId:this.threadId,error:describe(args[0])});
 if(type==='exit'||type==='online')trace(type,{threadId:this.threadId,code:args[0]});
 return originalEmit.call(this,type,...args);
};
wt.Worker=new Proxy(OriginalWorker,{construct(target,args,newTarget){
 trace('construct',{filename:String(args[0]),options:args[1]});
 try{const worker=Reflect.construct(target,args,newTarget);trace('constructed',{threadId:worker.threadId});return worker}
 catch(error){trace('construct-error',{error:describe(error)});throw error}
}});
trace('instrumented',{constructorWrapped:wt.Worker!==OriginalWorker});
const wasiThreads=require('@emnapi/wasi-threads');
const originalImports=wasiThreads.WASIThreads.prototype.getImportObject;
wasiThreads.WASIThreads.prototype.getImportObject=function(...args){
 const imports=originalImports.apply(this,args),spawn=imports.wasi['thread-spawn'];
 if(this.PThread){const print=this.PThread.printErr;this.PThread.printErr=function(...values){trace('thread-print-error',{values:values.map(value=>String(value))});return print.apply(this,values)}}
 imports.wasi['thread-spawn']=function(...values){trace('thread-spawn',{values});try{const result=spawn(...values);trace('thread-spawn-result',{result});return result}catch(error){trace('thread-spawn-error',{error:describe(error)});throw error}};
 trace('wasi-imports',{childThread:this.childThread,hasThreadManager:Boolean(this.PThread)});
 return imports;
};
const memoryFacts=phase=>{if(typeof globalThis.__qjsWasmMemoryDiagnostics==='function')trace('memory-diagnostics',{phase,fields:globalThis.__qjsWasmMemoryDiagnostics()})};
memoryFacts('before-binding');
let binding;
try{binding=require('@rolldown/binding-wasm32-wasi');trace('binding-loaded',{});binding.startAsyncRuntime();trace('runtime-started',{});memoryFacts('runtime-started')}
catch(error){memoryFacts('binding-error');trace('binding-error',{error:describe(error)});throw error}
finally{if(binding){try{binding.shutdownAsyncRuntime();trace('shutdown',{})}catch(error){trace('shutdown-error',{error:describe(error)});throw error}}}
`
    const native=spawnSync(process.execPath,['-e',source+'\nprocess.exit(0);'],{cwd:resolve('fixtures/compiler-wasi'),encoding:'utf8',timeout:15000})
    const nativeEvents=(native.stdout??'').split('\n').filter(line=>line.startsWith('WORKER_TRACE ')).map(line=>JSON.parse(line.slice('WORKER_TRACE '.length)))
    const nativePath=info.outputPath('native-rolldown-worker-trace.json')
    await writeFile(nativePath,JSON.stringify({node:process.version,status:native.status,signal:native.signal,error:native.error?.message,stdout:native.stdout,stderr:native.stderr,events:nativeEvents},null,2))
    await info.attach('native-rolldown-worker-trace.json',{path:nativePath,contentType:'application/json'})
    expect(native.status,native.stderr||native.error?.message).toBe(0)
    expect(nativeEvents.some(event=>event.type==='thread-spawn'),'native control observes real WASI thread spawn').toBe(true)
    expect(nativeEvents.some(event=>event.type==='construct'),'native control observes real Worker construction').toBe(true)
    const evidence=await page.evaluate(async({source,growthReservation})=>{
      const events=[],cleanup=[];let kernel,result,error
      try{
        const snapshot=await fetch('/fixture.json').then(response=>response.json())
        const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
        files['/project/trace.cjs']=source
        kernel=new window.sdk.WorkerKernel(files,{experimentalFibers:true,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation},maxBytes:256*1024*1024,timeoutMs:15000,workspace:{maxBytes:64*1024*1024}})
        result=await kernel.runModule('/project/trace.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,timeoutMs:15000,maxBytes:256*1024*1024,onOutput:(level,text)=>events.push({sequence:events.length,at:performance.now(),level,text})})
      }catch(cause){error={name:cause.name,message:cause.message,stack:cause.stack}}
      finally{if(kernel)try{kernel.close()}catch(cause){cleanup.push({name:cause.name,message:cause.message,stack:cause.stack})}}
      return {scope:'Instrumented worker startup diagnostic, not acceptance',events,result,error,cleanup}
    },{source,growthReservation})
    const path=info.outputPath('rolldown-worker-trace.json')
    await writeFile(path,JSON.stringify({sdkOutput:root,diagnosticRoot,diagnosticBuild,growthReservation,...evidence},null,2))
    await info.attach('rolldown-worker-trace.json',{path,contentType:'application/json'})
    expect(evidence.events.some(event=>event.text.includes('WORKER_TRACE')),'diagnostic observer ran').toBe(true)
    if(diagnosticRoot){
      const snapshots=evidence.events.filter(event=>event.text.startsWith('WORKER_TRACE ')).map(event=>JSON.parse(event.text.slice('WORKER_TRACE '.length))).filter(event=>event.type==='memory-diagnostics')
      expect(snapshots.some(event=>event.phase==='before-binding'),'memory observer baseline captured').toBe(true)
      expect(snapshots.some(event=>event.phase==='binding-error'||event.phase==='runtime-started'),'memory observer captured outcome, not just baseline').toBe(true)
      for(const snapshot of snapshots){
        expect(snapshot.fields).toHaveLength(8)
        expect(snapshot.fields.every(value=>Number.isFinite(value)&&value>=0)).toBe(true)
      }
    }
  }finally{await new Promise(done=>server.close(done))}
})
