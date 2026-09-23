// Diagnostic-only, independent of WebDriver after installation.
export function installSafariPreviewLiveness(ownerOrigin,expectedHeading,observeServerCall=false){
  const documentId=crypto.randomUUID()
  let emissions=0,disposed=false,serverCallClicked=false
  const emit=kind=>{
    if(disposed||emissions>=120)return
    emissions++
    parent.postMessage({type:'sandbox-preview-liveness',kind,documentId,
      readyState:document.readyState,hydrated:document.querySelector('main')?.getAttribute('data-hydrated')==='true',
      headingMatches:document.querySelector('h1')?.textContent===expectedHeading,at:performance.now(),emissionCount:emissions,limitReached:emissions===120,
      ...(observeServerCall?{serverCallClicked,serverReplyMatches:document.querySelector('#server-reply')?.textContent?.includes('"method":"POST"')===true}:{})},ownerOrigin)
    if(emissions===120)dispose()
  }
  const pagehide=()=>emit('pagehide'),pageshow=()=>emit('pageshow')
  const click=event=>{if(event.target?.closest?.('#server-call')){serverCallClicked=true;emit('server-click')}}
  const timer=setInterval(()=>emit('tick'),1000)
  const dispose=()=>{disposed=true;clearInterval(timer);removeEventListener('pagehide',pagehide);removeEventListener('pageshow',pageshow);if(observeServerCall)document.removeEventListener('click',click,true)}
  addEventListener('pagehide',pagehide)
  addEventListener('pageshow',pageshow)
  if(observeServerCall)document.addEventListener('click',click,true)
  emit('initial')
  return dispose
}

export function installSafariPreviewCollector(iframe,previewOrigin){
  const events=[]
  let received=0,loads=0
  const listener=event=>{
    if(event.source!==iframe.contentWindow||event.origin!==previewOrigin)return
    const value=event.data
    if(!value||value.type!=='sandbox-preview-liveness'||
      !['initial','tick','pagehide','pageshow','server-click'].includes(value.kind)||
      typeof value.documentId!=='string'||value.documentId.length>128||value.documentId.length===0||
      !['loading','interactive','complete'].includes(value.readyState)||
      typeof value.hydrated!=='boolean'||typeof value.headingMatches!=='boolean'||
      typeof value.at!=='number'||!Number.isFinite(value.at)||value.at<0||
      !Number.isInteger(value.emissionCount)||value.emissionCount<0||value.emissionCount>120||
      value.limitReached!==(value.emissionCount===120))return
    const serverFields=value.serverCallClicked!==undefined||value.serverReplyMatches!==undefined
    if(serverFields&&(typeof value.serverCallClicked!=='boolean'||typeof value.serverReplyMatches!=='boolean'))return
    received++
    events.push({kind:value.kind,documentId:value.documentId,readyState:value.readyState,hydrated:value.hydrated,headingMatches:value.headingMatches,at:value.at,emissionCount:value.emissionCount,limitReached:value.limitReached,...(serverFields?{serverCallClicked:value.serverCallClicked,serverReplyMatches:value.serverReplyMatches}:{})})
    if(events.length>64)events.shift()
  }
  const load=()=>{loads++}
  addEventListener('message',listener)
  iframe.addEventListener('load',load)
  const probe={snapshot:()=>({events:events.map(row=>({...row})),received,dropped:received-events.length,loads}),
    dispose:()=>{removeEventListener('message',listener);iframe.removeEventListener('load',load)}}
  globalThis.__safariPreviewLiveness=probe
  return probe
}
