// Diagnostic-only wrappers. Return the original promises and request objects.
// Never include URLs, database names, buffers, arguments or result payloads.
export function installSafariInstallStageTrace(){
  let next=0
  const sent={io:0,phase:0}
  const send=(id,stage,state,channel='io')=>{
    if(sent[channel]>=2048)return
    sent[channel]++
    try{
      self.postMessage({type:'sandbox-install-stage',channel,traceId:id,stage,state,at:performance.now()})
      if(sent[channel]===2048)self.postMessage({type:'sandbox-install-stage',channel,traceId:0,stage:'trace',state:'limit',at:performance.now()})
    }catch{}
  }
  const wrapPromise=(object,key,stage)=>{
    const original=object?.[key]
    if(typeof original!=='function')return
    object[key]=function(...args){
      const id=++next;send(id,stage,'begin')
      try{
        const result=Reflect.apply(original,this,args)
        void result.then(()=>send(id,stage,'end'),()=>send(id,stage,'error'))
        return result
      }catch(error){send(id,stage,'error');throw error}
    }
  }
  wrapPromise(self,'fetch','fetch-headers')
  for(const method of ['arrayBuffer','blob','bytes','formData','json','text']){
    wrapPromise(self.Response?.prototype,method,'response-body')
  }
  wrapPromise(self.ReadableStreamDefaultReader?.prototype,'read','stream-read')
  wrapPromise(self.ReadableStreamBYOBReader?.prototype,'read','stream-read')
  wrapPromise(self.crypto?.subtle,'digest','integrity')
  const phaseStages=new Set(['install-planning','workspace-staging','tar-extraction','package-file-write','workspace-commit'])
  const phases=new Map()
  self.__sandboxInstallPhaseTrace=(stage,state,id)=>{
    if(!phaseStages.has(stage))return
    if(state==='begin'){
      if(sent.phase>=2048)return
      const traceId=++next
      phases.set(traceId,stage)
      send(traceId,stage,'begin','phase')
      return traceId
    }
    if((state==='end'||state==='error')&&phases.get(id)===stage){
      phases.delete(id)
      send(id,stage,state,'phase')
    }
  }
  if(self.indexedDB){
    const original=self.indexedDB.open
    self.indexedDB.open=function(...args){
      const id=++next;send(id,'database-open','begin')
      try{
        const request=Reflect.apply(original,this,args)
        for(const event of ['success','error','blocked'])request.addEventListener(event,()=>send(id,'database-open',event),{once:true})
        return request
      }catch(error){send(id,'database-open','error');throw error}
    }
  }
  if(self.IDBDatabase){
    const original=self.IDBDatabase.prototype.transaction
    self.IDBDatabase.prototype.transaction=function(...args){
      const id=++next;send(id,'database-transaction','begin')
      try{
        const transaction=Reflect.apply(original,this,args)
        for(const event of ['complete','abort','error'])transaction.addEventListener(event,()=>send(id,'database-transaction',event),{once:true})
        return transaction
      }catch(error){send(id,'database-transaction','error');throw error}
    }
  }
  if(self.DecompressionStream){
    self.DecompressionStream=new Proxy(self.DecompressionStream,{construct(Target,args,newTarget){
      const id=++next;send(id,'decompression-create','begin')
      try{const stream=Reflect.construct(Target,args,newTarget);send(id,'decompression-create','end');return stream}
      catch(error){send(id,'decompression-create','error');throw error}
    }})
  }
}
export const safariInstallStageTraceSource=`(${installSafariInstallStageTrace.toString()})();\n`
