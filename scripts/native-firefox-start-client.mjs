// Browser-only acceptance driver. No debugger protocol or runtime internals.
export function classifyNavigationCancellations(evidence){
  const cancellations=[],fatal=[]
  for(const message of evidence.previewDiagnostics??[]){
    const match=/^TypeError: error loading dynamically imported module: (https?:\/\/\S+)$/.exec(message)
    const ready=evidence.readiness
    const matchingErrors=(evidence.documentEvents??[]).filter(event=>['error','unhandledrejection'].includes(event.kind)&&event.message===message)
    const error=matchingErrors.length===1&&matchingErrors[0].kind==='error'&&matchingErrors[0].documentId!==ready?.documentId?matchingErrors[0]:undefined
    const replacement=(evidence.documentEvents??[]).find(event=>event.kind==='start'&&event.documentId===ready?.documentId)
    const navigation=replacement?.timeOrigin
    const reload=(evidence.reloads??[]).find(row=>row.documentId===error?.documentId&&row.protocol==='vite-hmr'&&row.payload.type==='full-reload'&&[undefined,'*','/'].includes(row.payload.path)&&row.at<=navigation&&row.at>=error?.timeOrigin)
    const request=(evidence.http??[]).find(row=>row.url===match?.[1]&&row.documentId===error?.documentId&&row.startedAt<=navigation&&row.bodyCompletedAt>navigation&&row.status===200&&!row.bodyError)
    const replacementRequest=(evidence.http??[]).find(row=>row.url===match?.[1]&&row.documentId===ready?.documentId&&row.startedAt>=navigation&&row.bodyCompletedAt>=row.startedAt&&row.status===200&&!row.bodyError)
    const completed=(evidence.completedPreviewRequests??[]).filter(row=>match&&row.pathname===new URL(match[1]).pathname&&row.status===200)
    if(match&&error&&replacement&&reload&&request&&replacementRequest&&completed.length>=2&&ready.seenBootstrap&&ready.hydrated&&ready.streamEnded&&ready.timeOrigin===navigation&&Number(error.documentId)+1===Number(ready.documentId)&&reload.at<=error.at&&error.at<replacement.at){
      cancellations.push({message,error,reload,request,replacement,replacementRequest})
    }else fatal.push(message)
  }
  return {cancellations,fatal}
}

export async function runNativeStart({sdk,config,store,fingerprint,classify}) {
  const resumed=new URL(location.href).searchParams.has('resume')
  const evidence={resumed,stages:[],logs:[],errors:[],http:[],userAgent:navigator.userAgent,crossOriginIsolated,instrumentation:'HTML responses buffered to insert a test-only readiness observer before app scripts; SDK and guest source bytes unchanged'}
  let kernel,child,preview,drain,readiness,stopPromise,documentId=0
  evidence.documentEvents=[]
  evidence.reloads=[]
  const retain=(list,value,limit=128)=>{list.push(value);if(list.length>limit)list.shift()}
  const check=(value,message)=>{if(!value)throw Error(message)}
  const report=(kind,value)=>fetch(`/__test/${kind}?token=${config.token}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})
  const stage=async name=>{evidence.stages.push(name);await report('stage',{name,resumed})}
  const sleep=()=>new Promise(resolve=>setTimeout(resolve,20))
  const until=async(predicate,deadline,label)=>{while(Date.now()<deadline){if(await predicate())return;await sleep()}throw Error(label+' timed out')}
  const listener=event=>{if(event.origin!==config.previewOrigin||event.source!==preview?.frame.contentWindow)return;if(event.data?.type==='native-start-document-event')retain(evidence.documentEvents,event.data,64);if(event.data?.type==='native-start-readiness'&&event.data.documentId===String(documentId))readiness=event.data}
  addEventListener('message',listener)
  addEventListener('securitypolicyviolation',event=>{void report('violation',{blockedURI:event.blockedURI,effectiveDirective:event.effectiveDirective,resumed})})
  addEventListener('error',event=>retain(evidence.errors,String(event.message).slice(0,4000),32))
  addEventListener('unhandledrejection',event=>retain(evidence.errors,String(event.reason).slice(0,4000),32))
  function stop(){return stopPromise??=cleanup()}
  async function cleanup(){if(preview){evidence.previewDiagnostics=preview.diagnostics.slice(-32);evidence.completedPreviewRequests=preview.requests.slice(-256)}preview?.close();preview=undefined;if(child){await child.dispose();child=undefined}await drain;if(kernel){evidence.resources=await kernel.resources();kernel.close();const shutdown=kernel.shutdown;await shutdown;evidence.shutdownAcknowledged=Boolean(shutdown);evidence.jobProfile=kernel.jobProfile}}
  function verifyClean(){evidence.previewClassification=classify(evidence);check(evidence.errors.length===0,'Owner runtime errors');check(!evidence.previewClassification.fatal.length,'Preview runtime errors');check(!evidence.drainError,'Process output drain failed');check(evidence.shutdownAcknowledged,'Kernel shutdown not acknowledged');check(evidence.resources?.processes.active===0,'Processes remain active');check(evidence.resources?.nativeParser?.callable?.failed===0,'Compiler callable failures');check(evidence.resources?.nativeParser?.failedCalls===0,'Native parser failures')}
  async function visible(text,deadline=Date.now()+5000){await until(async()=>{const state=await preview.inspect();return state.controls.some(control=>control.tag==='button'&&control.text?.replace(/\s+/g,' ').trim()===text)},deadline,'Counter '+text)}
  async function edit(from,to){const path='/project/src/routes/index.tsx',source=await kernel.readText(path);check(source.split(from).length===2,'Route edit target changed');await kernel.writeText(path,source.replace(from,to))}
  try{
    check(crossOriginIsolated,'Owner must be cross-origin isolated')
    kernel=new sdk.WorkerKernel(resumed?{}:config.files,config.ownerPolicy)
    if(resumed){
      const saved=await store({operation:'load'});check(saved,'Missing saved workspace');await kernel.restore(saved)
      evidence.restored=await fingerprint(await kernel.snapshot())
      check(JSON.stringify(evidence.restored)===sessionStorage.getItem('native-start-fingerprint'),'Restored workspace fingerprint differs')
      check(await kernel.readText('/project/count.txt')==='2','Restored counter differs')
      await stage('restored files, dependencies and optimizer cache without install')
    }else{evidence.install=await kernel.install({cwd:'/project',ignoreScripts:true});await stage('installed portable graph')}
    child=await kernel.spawn('node',['sdk-acceptance-server.mjs'],{cwd:'/project',env:config.processEnv,guestWasm:true,webAPIs:true,lifetime:'session',maxBytes:256*1024*1024,timeoutMs:30000,diagnostics:true})
    let output=''
    for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr'){const text=new TextDecoder().decode(event.bytes);retain(evidence.logs,text.slice(-8000));output=(output+text).slice(-32000)}if(output.includes('SITE_START_READY'))break;check(event&&event.type!=='exit','Start exited before ready: '+output)}
    drain=(async()=>{try{for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr')retain(evidence.logs,new TextDecoder().decode(event.bytes).slice(-8000));else break}}catch(error){evidence.drainError=String(error)}})()
    const http=new sdk.WorkerHTTP(kernel,3000)
    const ssr=await http.fetch(new Request(config.previewOrigin+'/')),html=await ssr.text()
    const expected=resumed?'Increment 2?':'Add 1 to 0?'
    check(ssr.status===200,'SSR status '+ssr.status)
    check(new DOMParser().parseFromString(html,'text/html').querySelector('button')?.textContent?.replace(/\s+/g,' ').trim()===expected,'SSR counter differs')
    check(html.includes('self.$_TSR='),'SSR bootstrap missing')
    evidence.ssr={status:ssr.status,expected};evidence.parserAfterSSR=(await kernel.resources()).nativeParser
    check(evidence.parserAfterSSR?.completedCalls>0,'SSR did not complete native parser work')
    check(evidence.parserAfterSSR?.callable?.completed>0,'SSR did not complete shared compiler callable work')
    await stage('SSR')
    const mountedAt=Date.now(),deadline=mountedAt+30000
    // Test-only document observer, app source and packaged SDK bytes stay intact.
    const server={fetch:async request=>{
      if(new URL(request.url).pathname==='/__native/readiness.js')return new Response(config.readinessScript,{headers:{'Content-Type':'text/javascript'}})
      const row={url:request.url,documentId:String(documentId),startedAt:Date.now()};evidence.http.push(row);if(evidence.http.length>256)evidence.http.shift()
      const response=await http.fetch(request);row.headersAt=Date.now();row.status=response.status
      if(!response.headers.get('content-type')?.includes('text/html')){
        if(!response.body){row.bodyCompletedAt=Date.now();return response}
        const reader=response.body.getReader()
        const body=new ReadableStream({async pull(controller){try{const result=await reader.read();if(result.done){row.bodyCompletedAt=Date.now();controller.close()}else controller.enqueue(result.value)}catch(error){row.bodyError=String(error);controller.error(error)}},cancel(reason){row.bodyError=String(reason??'cancelled');return reader.cancel(reason)}})
        return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers})
      }
      const text=await response.text();check(/<head(?:\s[^>]*)?>/i.test(text),'Preview head missing');documentId++;readiness=undefined
      const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding')
      return new Response(text.replace(/<head(?:\s[^>]*)?>/i,head=>head+`<script src="/__native/readiness.js?document=${documentId}"></script>`),{status:response.status,headers})
    }}
    preview=await sdk.URLPreview.mount(document.querySelector('#preview'),{origin:config.previewOrigin,server,connectWebSocket:async(url,protocols)=>{
      const socketDocumentId=String(documentId),socket=await sdk.WorkerWebSocket.connect(kernel,3000,config.previewOrigin,url,protocols)
      return new Proxy(socket,{get(target,key){if(key==='next')return async()=>{const event=await target.next();if(event?.type==='text'){try{const payload=JSON.parse(event.data);if(payload.type==='full-reload')retain(evidence.reloads,{documentId:socketDocumentId,at:Date.now(),protocol:target.protocol,payload},32)}catch{}}return event};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
    }})
    await until(()=>readiness?.documentId===String(documentId)&&readiness.seenBootstrap&&readiness.hydrated&&readiness.streamEnded,deadline,'Hydration')
    evidence.readiness=readiness;await visible(expected,deadline)
    await stage('hydrated')
    await preview.click('button');await visible(resumed?'Increment 3?':'Add 1 to 1?')
    await edit(resumed?'Increment {state}?':'Add 1 to {state}?',resumed?'Resumed {state}?':'Increment {state}?')
    await visible(resumed?'Resumed 3?':'Increment 1?');await stage('HMR without owner reload')
    await preview.click('button');await visible(resumed?'Resumed 4?':'Increment 2?')
    check(await kernel.readText('/project/count.txt')===(resumed?'4':'2'),'Server function did not persist counter')
    await stage('server functions and filesystem verified')
    if(!resumed){
      evidence.completedPreviewRequests=preview.requests.slice(-256)
      evidence.previewDiagnostics=preview.diagnostics.slice(-32);preview.close();preview=undefined;await child.dispose();child=undefined;await drain
      const resources=await kernel.resources();check(resources.processes.active===0,'Process remains active before snapshot')
      const snapshot=await kernel.snapshot(),saved=await fingerprint(snapshot)
      check(saved.packageFiles>0&&saved.cacheFiles>0,'Snapshot lacks dependencies or optimizer cache')
      await store({operation:'save',snapshot});sessionStorage.setItem('native-start-fingerprint',JSON.stringify(saved));evidence.saved=saved
      await stop();verifyClean();await report('cold',evidence)
      const response=await report('offline',{});check(response.ok,'Offline policy not enabled')
      location.replace('/app/?resume=1');return
    }
    await store({operation:'delete'});await stop();verifyClean();await report('result',{...evidence,passed:true})
  }catch(error){evidence.readiness=readiness;evidence.failure=String(error)+'\n'+String(error?.stack??'');evidence.failureName=error?.name;evidence.failureMessage=error?.message;try{await stop()}catch(cleanup){evidence.cleanupError=String(cleanup)}await report('result',{...evidence,passed:false})}
  finally{removeEventListener('message',listener)}
}

export function observeNativeStartReadiness(){
  const documentId=new URL(document.currentScript.src).searchParams.get('document')
  const record=(kind,message)=>parent.postMessage({type:'native-start-document-event',documentId,timeOrigin:performance.timeOrigin,at:Date.now(),kind,message:String(message??'').slice(0,4000)},'*')
  addEventListener('error',event=>record('error',event.message))
  addEventListener('unhandledrejection',event=>record('unhandledrejection',event.reason))
  addEventListener('pagehide',()=>record('pagehide'),{once:true})
  record('start')
  let bootstrap
  const sample=()=>{if(globalThis.$_TSR?.h)bootstrap=globalThis.$_TSR;parent.postMessage({type:'native-start-readiness',documentId,timeOrigin:performance.timeOrigin,seenBootstrap:Boolean(bootstrap),hydrated:bootstrap?.hydrated===true,streamEnded:bootstrap?.streamEnded===true},'*')}
  const observer=new MutationObserver(sample);observer.observe(document,{childList:true,subtree:true})
  document.addEventListener('readystatechange',sample)
  const timer=setInterval(sample,20),stop=()=>{observer.disconnect();clearInterval(timer);document.removeEventListener('readystatechange',sample)}
  addEventListener('pagehide',stop,{once:true});setTimeout(stop,30000);sample()
}
