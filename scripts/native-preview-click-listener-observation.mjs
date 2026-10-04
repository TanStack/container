// Test-only listener metadata. No application state, callbacks or arguments are recorded.
export function installNativePreviewClickListenerObservation({previewOrigin,maxEvents=128}){
  if(location.origin!==previewOrigin)return
  if(!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>512)
    throw new TypeError('Invalid click listener observation limit')
  const prototype=EventTarget.prototype
  const add=Object.getOwnPropertyDescriptor(prototype,'addEventListener')
  const remove=Object.getOwnPropertyDescriptor(prototype,'removeEventListener')
  const state={rows:[],dropped:0},listeners=new WeakMap(),targets=new WeakMap()
  const started=performance.now(),documentTimeOrigin=performance.timeOrigin
  let nextListener=0,nextTarget=0,stopped=false
  const safe=fn=>{try{return fn()}catch{}}
  const targetMetadata=target=>{
    if(!target||typeof target!=='object')return {target:0,tag:'unknown'}
    let id=targets.get(target)
    if(!id){id=++nextTarget;targets.set(target,id)}
    return {target:id,tag:target===document?'document':target===globalThis?'window':
      target instanceof HTMLElement?target.tagName.toLowerCase():'other'}
  }
  const record=(kind,fields={})=>safe(()=>{
    if(stopped)return
    const row={kind,...fields,documentTimeOrigin,elapsedMs:Math.round(performance.now()-started)}
    state.rows.push(row)
    if(state.rows.length>maxEvents){state.rows.shift();state.dropped++}
    console.info('NATIVE_PREVIEW_CLICK_LISTENER '+JSON.stringify(row))
  })
  const listenerId=listener=>{
    if(!listener||!['function','object'].includes(typeof listener))return 0
    let id=listeners.get(listener)
    if(!id){id=++nextListener;listeners.set(listener,id)}
    return id
  }
  function observedAdd(){
    const result=Reflect.apply(add.value,this,arguments)
    if(arguments[0]==='click')safe(()=>record('listener-add',{
      listener:listenerId(arguments[1]),callable:typeof arguments[1]==='function',...targetMetadata(this),
      // Do not re-read options getters or convert the native event type again.
      capture:typeof arguments[2]==='boolean'?arguments[2]:undefined,
    }))
    return result
  }
  function observedRemove(){
    const result=Reflect.apply(remove.value,this,arguments)
    if(arguments[0]==='click')safe(()=>record('listener-remove',{
      listener:listenerId(arguments[1]),...targetMetadata(this),
    }))
    return result
  }
  // Callbacks and options pass through untouched. Wrapping a callback changes
  // native error reporting in WebKit, so invocation tracing is not used.
  Object.defineProperty(prototype,'addEventListener',{...add,value:observedAdd})
  Object.defineProperty(prototype,'removeEventListener',{...remove,value:observedRemove})
  Object.defineProperty(globalThis,'__nativePreviewClickListenerObservation',{value:{
    snapshot:()=>({documentTimeOrigin,dropped:state.dropped,rows:state.rows.map(row=>({...row}))}),
    stop(){
      if(stopped)return;stopped=true
      if(prototype.addEventListener===observedAdd)Object.defineProperty(prototype,'addEventListener',add)
      if(prototype.removeEventListener===observedRemove)Object.defineProperty(prototype,'removeEventListener',remove)
    },
  }})
  record('installed')
}
