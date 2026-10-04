// Opt-in test instrumentation. It observes existing calls, never consumes,
// clones, retries, cancels or waits for a response on the application's behalf.
export function installFetchConsumptionObservation({previewOrigin,pathPrefix,maxEvents=256}){
  if(location.origin!==previewOrigin)return
  if(!pathPrefix?.startsWith('/')||!pathPrefix.endsWith('/')||!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>256)
    throw new TypeError('Choose a path prefix and an event limit from 1 to 256')
  const state={rows:[],limited:false},responses=new WeakMap(),streams=new WeakMap(),readers=new WeakMap()
  const started=performance.now(),then=Promise.prototype.then
  let nextRequest=0
  const safe=callback=>{try{callback()}catch{}}
  const record=(kind,request,extra={})=>safe(()=>{
    if(state.rows.length===maxEvents){
      if(!state.limited){state.limited=true;console.info('NATIVE_FETCH_CONSUMPTION '+JSON.stringify({kind:'limit',maxEvents}))}
      return
    }
    const row={kind,...request,elapsedMs:Math.round(performance.now()-started),visibility:document.visibilityState,...extra}
    state.rows.push(row)
    console.info('NATIVE_FETCH_CONSUMPTION '+JSON.stringify(row))
  })
  const watch=(promise,fulfilled,rejected)=>{
    // Return the exact original promise to the caller, not our observation branch.
    safe(()=>Reflect.apply(then,promise,[value=>safe(()=>fulfilled(value)),error=>safe(()=>rejected(error))]))
    return promise
  }
  const rejected=(kind,request)=>()=>record(kind,request)
  const tag=(response,request)=>{
    responses.set(response,request)
    if(response.body)streams.set(response.body,request)
  }
  const fetch=globalThis.fetch
  globalThis.fetch=function(input,init){
    let request
    safe(()=>{
      const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href)
      if(url.origin===previewOrigin&&url.pathname.startsWith(pathPrefix))
        request={id:++nextRequest,method:init?.method??input?.method??'GET',pathname:pathPrefix+'[id]'}
    })
    if(!request)return Reflect.apply(fetch,this,arguments)
    record('fetch-start',request)
    let promise
    try{promise=Reflect.apply(fetch,this,arguments)}
    catch(error){record('fetch-throw',request);throw error}
    return watch(promise,response=>{
      tag(response,request)
      record('fetch-fulfilled',request,{status:response.status})
    },rejected('fetch-rejected',request))
  }
  for(const method of ['arrayBuffer','blob','bytes','formData','json','text']){
    const original=Response.prototype[method]
    if(typeof original!=='function')continue
    Response.prototype[method]=function(){
      const request=responses.get(this)
      if(!request)return Reflect.apply(original,this,arguments)
      record(method+'-start',request)
      let promise
      try{promise=Reflect.apply(original,this,arguments)}
      catch(error){record(method+'-throw',request);throw error}
      return watch(promise,()=>record(method+'-fulfilled',request),rejected(method+'-rejected',request))
    }
  }
  const clone=Response.prototype.clone
  Response.prototype.clone=function(){
    const response=Reflect.apply(clone,this,arguments),request=responses.get(this)
    if(request){safe(()=>tag(response,request));record('clone',request)}
    return response
  }
  const getReader=ReadableStream.prototype.getReader
  ReadableStream.prototype.getReader=function(){
    const reader=Reflect.apply(getReader,this,arguments),request=streams.get(this)
    if(request){readers.set(reader,request);record('reader-acquired',request)}
    return reader
  }
  for(const Reader of [globalThis.ReadableStreamDefaultReader,globalThis.ReadableStreamBYOBReader]){
    if(!Reader)continue
    for(const method of ['read','cancel']){
      const original=Reader.prototype[method]
      if(typeof original!=='function')continue
      Reader.prototype[method]=function(){
        const request=readers.get(this)
        if(!request)return Reflect.apply(original,this,arguments)
        record(method+'-start',request)
        let promise
        try{promise=Reflect.apply(original,this,arguments)}
        catch(error){record(method+'-throw',request);throw error}
        return watch(promise,value=>record(method+'-fulfilled',request,method==='read'
          ?{done:!!value.done,bytes:Number.isSafeInteger(value.value?.byteLength)?value.value.byteLength:0}:{}),
          rejected(method+'-rejected',request))
      }
    }
    const releaseLock=Reader.prototype.releaseLock
    Reader.prototype.releaseLock=function(){
      const result=Reflect.apply(releaseLock,this,arguments),request=readers.get(this)
      if(request)record('reader-released',request)
      return result
    }
  }
  Object.defineProperty(globalThis,'__nativeFetchConsumptionObservation',{value:state})
}
