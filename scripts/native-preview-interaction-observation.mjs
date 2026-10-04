// Opt-in browser-test metadata. Never clicks, retries, reads app state or waits.
export function installNativePreviewInteractionObservation({previewOrigin,maxEvents=64}){
  if(location.origin!==previewOrigin)return
  if(!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>256)
    throw new TypeError('Invalid interaction observation limit')
  const state={rows:[],dropped:0},listeners=[],targets=new WeakMap()
  const started=performance.now(),documentTimeOrigin=performance.timeOrigin
  let nextTarget=0,stopped=false
  const safe=fn=>{try{return fn()}catch{}}
  const targetMetadata=element=>{
    if(!(element instanceof HTMLElement))return {target:0}
    let target=targets.get(element)
    if(!target){target=++nextTarget;targets.set(element,target)}
    return {target,tag:element.tagName.toLowerCase(),connected:element.isConnected,
      disabled:typeof element.disabled==='boolean'?element.disabled:undefined}
  }
  const record=(kind,fields={})=>safe(()=>{
    if(stopped)return
    const row={kind,...fields,documentTimeOrigin,elapsedMs:Math.round(performance.now()-started),readyState:document.readyState}
    state.rows.push(row)
    if(state.rows.length>maxEvents){state.rows.shift();state.dropped++}
    console.info('NATIVE_PREVIEW_INTERACTION '+JSON.stringify(row))
  })
  const on=(target,name,callback,capture=false)=>{
    target.addEventListener(name,callback,capture);listeners.push([target,name,callback,capture])
  }
  on(document,'DOMContentLoaded',()=>record('dom-content-loaded'))
  on(globalThis,'load',event=>{if(event.target===document)record('window-loaded')})
  for(const capture of [true,false])on(document,'click',event=>safe(()=>record(capture?'click-capture':'click-bubble',{
    ...targetMetadata(event.target),trusted:event.isTrusted,defaultPrevented:event.defaultPrevented,
  })),capture)
  for(const name of ['load','error'])on(document,name,event=>safe(()=>{
    const element=event.target
    if(element?.tagName==='SCRIPT')record('script-'+name,{module:element.type==='module',external:Boolean(element.src)})
  }),true)
  const descriptor=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'click'),original=descriptor.value
  function observedClick(){
    safe(()=>record('click-call',targetMetadata(this)))
    try{
      const result=Reflect.apply(original,this,arguments)
      safe(()=>record('click-return',targetMetadata(this)))
      return result
    }catch(error){safe(()=>record('click-threw'));throw error}
  }
  Object.defineProperty(HTMLElement.prototype,'click',{...descriptor,value:observedClick})
  Object.defineProperty(globalThis,'__nativePreviewInteractionObservation',{value:{
    snapshot:()=>({documentTimeOrigin,dropped:state.dropped,rows:state.rows.map(row=>({...row}))}),
    dispose(){
      if(stopped)return;stopped=true
      for(const [target,name,callback,capture] of listeners)target.removeEventListener(name,callback,capture)
      if(HTMLElement.prototype.click===observedClick)Object.defineProperty(HTMLElement.prototype,'click',descriptor)
    },
  }})
  record('installed')
}
