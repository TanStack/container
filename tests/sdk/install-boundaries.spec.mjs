import {test,expect} from '@playwright/test'
import {writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {startPackagedFrameworkDiagnostic} from './helpers/packaged-framework-diagnostic.mjs'

// Diagnostic only. The served kernel gets an observer prelude, so this is not
// an acceptance run or a timing benchmark. SDK files on disk remain unchanged.
function observeInstallBoundaries(){
  let sequence=0,dropped=0,immediateSends=0
  const pending=new Map(),events=[],ids=new WeakMap(),seenReaders=new WeakSet()
  const send=()=>postMessage({__installBoundaryDiagnostic:{events:events.splice(0),pending:[...pending.values()],dropped,at:performance.now()}})
  const immediate=()=>{if(immediateSends++<128)send()}
  const record=(event)=>{events.push({at:performance.now(),...event});if(events.length>256){events.shift();dropped++}}
  const begin=(kind,detail)=>{const id=++sequence;const item={id,kind,detail,at:performance.now()};if(pending.size<128)pending.set(id,item);else dropped++;record({type:'begin',...item});if(kind!=='stream-read')immediate();return id}
  const end=(id,error)=>{const kind=pending.get(id)?.kind;pending.delete(id);record({type:error?'error':'end',id,...(error?{error:String(error)}:{})});if(kind&&kind!=='stream-read')immediate()}
  const watch=(promise,id)=>{promise.then(()=>end(id),error=>end(id,error));return promise}
  const digest=SubtleCrypto.prototype.digest
  SubtleCrypto.prototype.digest=function(algorithm,data){const id=begin('digest',{algorithm,bytes:data.byteLength});try{return watch(Reflect.apply(digest,this,[algorithm,data]),id)}catch(error){end(id,error);throw error}}
  const open=IDBFactory.prototype.open
  IDBFactory.prototype.open=function(...args){const id=begin('idb-open',{name:args[0],version:args[1]});const request=Reflect.apply(open,this,args);request.addEventListener('success',()=>end(id));request.addEventListener('error',()=>end(id,request.error));request.addEventListener('blocked',()=>record({type:'blocked',id}));return request}
  const transaction=IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction=function(...args){const id=begin('idb-transaction',{stores:args[0],mode:args[1]});try{const tx=Reflect.apply(transaction,this,args);tx.addEventListener('complete',()=>end(id));tx.addEventListener('abort',()=>end(id,tx.error??'aborted'));tx.addEventListener('error',()=>record({type:'transaction-error',id,error:String(tx.error)}));return tx}catch(error){end(id,error);throw error}}
  const NativeDecompressionStream=DecompressionStream
  globalThis.DecompressionStream=class extends NativeDecompressionStream{constructor(...args){super(...args);const id=++sequence;ids.set(this.readable,id);record({type:'decompression-created',id,format:args[0]});immediate()}}
  const getReader=ReadableStream.prototype.getReader
  ReadableStream.prototype.getReader=function(...args){const reader=Reflect.apply(getReader,this,args);ids.set(reader,ids.get(this)??++sequence);return reader}
  const read=ReadableStreamDefaultReader.prototype.read
  ReadableStreamDefaultReader.prototype.read=function(...args){const first=!seenReaders.has(this);seenReaders.add(this);const id=begin('stream-read',{stream:ids.get(this)});if(first)immediate();try{const promise=Reflect.apply(read,this,args);promise.then(value=>{record({type:'stream-result',id,done:value.done,bytes:value.value?.byteLength});end(id);if(first||value.done)immediate()},error=>{end(id,error);immediate()});return promise}catch(error){end(id,error);immediate();throw error}}
  record({type:'observer-ready'})
  setInterval(send,1000)
  send()
}

test('diagnostic WebKit Vite install native async boundaries',async({page},info)=>{
  test.skip(info.project.name!=='webkit','This diagnostic targets the observed WebKit stall')
  const {host,evidence}=await startPackagedFrameworkDiagnostic('sdk-install-boundaries-')
  const samples=[],errors=[]
  let discardedSamples=0
  await page.exposeFunction('__recordInstallBoundary',value=>{samples.push(value);if(samples.length>256){samples.shift();discardedSamples++}})
  const original=host.ownerOrigin+'/runtime/workers/kernel.js'
  let originalWorkerSHA256,instrumentedWorkerSHA256
  await page.route(original,async route=>{
    const response=await route.fetch(),source=await response.text()
    const body=`try { (${observeInstallBoundaries.toString()})(); } catch(error) { postMessage({__installBoundaryDiagnostic:{startupError:String(error),at:performance.now()}}); throw error; }\n`+source
    originalWorkerSHA256=createHash('sha256').update(source).digest('hex')
    instrumentedWorkerSHA256=createHash('sha256').update(body).digest('hex')
    await route.fulfill({response,body})
  })
  await page.addInitScript(({original})=>{
    const NativeWorker=Worker
    globalThis.Worker=class extends NativeWorker{
      constructor(url,options){
        const target=new URL(String(url),location.href).href
        super(url,options)
        if(target===original)this.addEventListener('message',event=>{
          if(event.data?.__installBoundaryDiagnostic)void globalThis.__recordInstallBoundary(event.data.__installBoundaryDiagnostic)
          else if(event.data?.type==='heartbeat')void globalThis.__recordInstallBoundary({type:'kernel-heartbeat',ownerAt:performance.now()})
        })
      }
    }
  },{original})
  page.on('pageerror',error=>{errors.push(String(error));if(errors.length>32)errors.shift()})
  try{
    await page.goto(host.ownerOrigin)
    await page.locator('#project').selectOption('vite')
    await page.locator('#open').click()
    await expect(page.frameLocator('#preview iframe').locator('#message')).toHaveText('Hello from Vite',{timeout:60000})
  }finally{
    const output=await page.locator('#output').textContent({timeout:1000}).catch(()=>null)
    const path=info.outputPath('install-boundaries.json')
    await writeFile(path,JSON.stringify({diagnosticOnly:true,modifiedWorkerResponse:original,originalWorkerSHA256,instrumentedWorkerSHA256,...evidence,samples,discardedSamples,errors,output},null,2))
    await info.attach('install-boundaries.json',{path,contentType:'application/json'})
    await host.close()
  }
})
