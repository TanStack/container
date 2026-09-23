import {test,expect} from '@playwright/test'
import {writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {startPackagedFrameworkDiagnostic} from './helpers/packaged-framework-diagnostic.mjs'

// Diagnostic only. Counters bypass worker message delivery and the Playwright
// binding used by install-boundaries. Native async APIs and their promises are
// not wrapped. The real installer and its limits remain unchanged.
const counterNames=['kernelAttached','kernelTimer','kernelReceived','installReceived','installReplied','kernelSent','heartbeatSent','lastMethod','siblingAttached','siblingTimer']
const methodCodes={init:1,install:2,execute:3,shutdown:4}
function kernelWitness(){
  let counters,installId
  const post=self.postMessage
  self.postMessage=function(...args){
    if(counters){
      Atomics.add(counters,5,1)
      if(args[0]?.type==='heartbeat')Atomics.add(counters,6,1)
      if(installId!==undefined&&args[0]?.id===installId&&args[0]?.type!=='output')Atomics.add(counters,4,1)
    }
    return Reflect.apply(post,this,args)
  }
  self.addEventListener('message',event=>{
    if(event.data?.__installLivenessBuffer){
      event.stopImmediatePropagation()
      counters=new Int32Array(event.data.__installLivenessBuffer)
      Atomics.store(counters,0,1)
      return
    }
    if(counters){
      Atomics.add(counters,2,1)
      Atomics.store(counters,7,({init:1,install:2,execute:3,shutdown:4})[event.data?.method]??0)
      if(event.data?.method==='install'){installId=event.data.id;Atomics.add(counters,3,1)}
    }
  })
  setInterval(()=>{if(counters)Atomics.add(counters,1,1)},1000)
}
function siblingWitness(){
  onmessage=event=>{
    const counters=new Int32Array(event.data)
    Atomics.store(counters,8,1)
    setInterval(()=>Atomics.add(counters,9,1),1000)
  }
}

test('diagnostic full packaged WebKit install shared liveness',async({page},info)=>{
  test.skip(info.project.name!=='webkit','This diagnostic targets the observed WebKit stall')
  const {host,evidence}=await startPackagedFrameworkDiagnostic('sdk-install-liveness-')
  const original=host.ownerOrigin+'/runtime/workers/kernel.js'
  const siblingURL=host.ownerOrigin+'/install-liveness-sibling.js'
  const errors=[]
  let capability,originalWorkerSHA256,instrumentedWorkerSHA256,outcome='not-started'
  const hash=value=>createHash('sha256').update(value).digest('hex')
  await page.route(siblingURL,route=>route.fulfill({contentType:'text/javascript',body:`(${siblingWitness.toString()})();`}))
  await page.route(original,async route=>{
    const response=await route.fetch(),source=await response.text()
    const body=`(${kernelWitness.toString()})();\n`+source
    originalWorkerSHA256=hash(source);instrumentedWorkerSHA256=hash(body)
    await route.fulfill({response,body})
  })
  await page.addInitScript(({original,siblingURL,ownerOrigin})=>{
    if(location.origin!==ownerOrigin)return
    const state=globalThis.__installLiveness={ownerTicks:0,samples:[],heartbeatReceived:0,kernelMessages:0,errors:[],supported:crossOriginIsolated&&typeof SharedArrayBuffer==='function'}
    if(!state.supported)return
    const buffer=new SharedArrayBuffer(10*Int32Array.BYTES_PER_ELEMENT),counters=new Int32Array(buffer)
    const NativeWorker=Worker
    let sibling,kernel
    const snapshot=()=>({at:performance.now(),ownerTicks:state.ownerTicks,counters:Array.from(counters,(_,index)=>Atomics.load(counters,index)),heartbeatReceived:state.heartbeatReceived,kernelMessages:state.kernelMessages,visibility:document.visibilityState})
    const timer=setInterval(()=>{state.ownerTicks++;state.samples.push(snapshot());if(state.samples.length>64)state.samples.shift()},1000)
    globalThis.__captureInstallLiveness=()=>({...state,current:snapshot()})
    globalThis.__disposeInstallLiveness=()=>{clearInterval(timer);sibling?.terminate();kernel?.terminate()}
    globalThis.Worker=class extends NativeWorker{
      constructor(url,options){
        super(url,options)
        if(new URL(String(url),location.href).href!==original)return
        kernel=this
        this.addEventListener('message',event=>{state.kernelMessages++;if(event.data?.type==='heartbeat')state.heartbeatReceived++})
        this.addEventListener('error',event=>{if(state.errors.length<16)state.errors.push({source:'kernel',message:event.message})})
        this.addEventListener('messageerror',()=>{if(state.errors.length<16)state.errors.push({source:'kernel',message:'messageerror'})})
        // This is enqueued before the SDK's init message. The prelude consumes
        // only this diagnostic message; ordinary RPCs retain their normal path.
        this.postMessage({__installLivenessBuffer:buffer})
        sibling=new NativeWorker(siblingURL,{type:'module'})
        sibling.addEventListener('error',event=>{if(state.errors.length<16)state.errors.push({source:'sibling',message:event.message})})
        sibling.postMessage(buffer)
      }
    }
  },{original,siblingURL,ownerOrigin:host.ownerOrigin})
  page.on('pageerror',error=>{if(errors.length<32)errors.push(String(error))})
  try{
    await page.goto(host.ownerOrigin)
    capability=await page.evaluate(()=>({crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer==='function'}))
    if(!capability.crossOriginIsolated||!capability.sharedArrayBuffer){outcome='skipped-missing-isolation';test.skip(true,'Shared liveness requires cross-origin isolation and SharedArrayBuffer')}
    await page.locator('#project').selectOption('vite')
    outcome='running'
    await page.locator('#open').click()
    await expect(page.frameLocator('#preview iframe').locator('#message')).toHaveText('Hello from Vite',{timeout:60000})
    const state=await page.evaluate(()=>globalThis.__captureInstallLiveness())
    expect(state.current.counters[0]).toBe(1)
    expect(state.current.counters[3]).toBe(1)
    expect(state.current.counters[4]).toBe(1)
    expect(state.current.counters[8]).toBe(1)
    outcome='preview-ready'
  }catch(error){if(outcome!=='skipped-missing-isolation')outcome='failed';throw error}
  finally{
    // A failed capture is evidence, not a zero-valued liveness sample.
    let deadline
    const capture=page.evaluate(()=>({state:globalThis.__captureInstallLiveness?.()??globalThis.__installLiveness,output:document.querySelector('#output')?.textContent})).catch(error=>({captureError:String(error)}))
    const captured=await Promise.race([capture,new Promise(done=>{deadline=setTimeout(()=>done({captureError:'Owner evaluation did not respond within 2000 ms'}),2000)})])
    clearTimeout(deadline)
    const path=info.outputPath('install-liveness.json')
    await writeFile(path,JSON.stringify({diagnosticOnly:true,...evidence,modifiedWorkerResponse:original,originalWorkerSHA256,instrumentedWorkerSHA256,counterNames,methodCodes,capability,outcome,errors,...captured},null,2))
    await info.attach('install-liveness.json',{path,contentType:'application/json'})
    // Stop the diagnostic workers without waiting on an unresponsive owner.
    await page.close().catch(()=>{})
    await host.close()
  }
})
