/** Guest-only promise pump. Host code settles transport.next, never calls callbacks.
 * Each invoke creates its continuation chain in the originating async context.
 * Warning/debug return values are ignored; async failures go to reportError.
 */
export function createGuestCallableDispatch(transport,callbackScope){
  const allowed=new Set(['resolveSubpathImports','finalizeBareSpecifier','finalizeOtherSpecifiers','onWarn','onDebug'])
  const records=new Map(),active=new Map()
  const waiting=[]
  let sequence=0,closed=false,occupied=0,ordinary=0
  const eligible=scoped=>occupied<64&&(scoped||ordinary<63)
  function occupy(scoped){occupied++;if(!scoped)ordinary++}
  function vacate(scoped){occupied--;if(!scoped)ordinary--;admit()}
  function admit(){
    while(!closed&&occupied<64&&waiting.length){
      const index=waiting.findIndex(entry=>eligible(entry.scoped))
      if(index<0)break
      const [entry]=waiting.splice(index,1);occupy(entry.scoped);entry.resolve()
    }
  }
  function report(error){transport.reportError(String(error))}
  function encode(value){
    if(value===undefined)return {type:'undefined'}
    if(value===null)return {type:'null'}
    if(typeof value==='string')return {type:'string',value}
    throw Error('Native callable callback must return string, null or undefined synchronously')
  }
  return {
    register(callbacks){
      if(closed)throw Error('Guest callable dispatch is closed')
      if(records.size>=64)throw Error('Guest callable registration limit')
      for(const [name,callback]of Object.entries(callbacks))if(!allowed.has(name)||typeof callback!=='function')throw Error('Unsupported native callable callback: '+name)
      const id=++sequence;records.set(id,{...callbacks});return id
    },
    release(handle){
      records.delete(handle)
      for(let index=waiting.length-1;index>=0;index--)if(waiting[index].handle===handle){
        const [entry]=waiting.splice(index,1);entry.reject(Error('Guest callable handle is released'))
      }
    },
    invoke(handle,method,args){
      if(closed)return Promise.reject(Error('Guest callable dispatch is closed'))
      const callbacks=records.get(handle)
      if(!callbacks)return Promise.reject(Error('Guest callable handle is released'))
      const scoped=transport.isScoped?.()===true
      if(!eligible(scoped)&&waiting.length>=1024)return Promise.reject(Error('Guest callable admission queue limit'))
      const origin=callbackScope?.getStore()
      let reservation
      try{reservation=transport.reserve?.(handle,method,args,origin)}catch(error){return Promise.reject(error)}
      function releaseReservation(){
        if(reservation!==undefined){const id=reservation;reservation=undefined;transport.releaseReservation(id)}
      }
      function begin(){
      let operation
      try{
        if(closed)throw Error('Guest callable dispatch is closed')
        if(!records.has(handle))throw Error('Guest callable handle is released')
        operation=transport.start(handle,method,args,origin,reservation)
        if(!Number.isSafeInteger(operation)||active.has(operation))throw Error('Invalid native callable operation id')
        reservation=undefined
      }catch(error){
        try{releaseReservation()}finally{vacate(scoped)}
        return Promise.reject(error)
      }
      let rejectCancellation
      const cancellation=new Promise((_,reject)=>{rejectCancellation=reject})
      active.set(operation,rejectCancellation)
      const seen=new Set()
      function pump(){
        // This .then is installed by guest execution, under this invocation's ALS.
        return Promise.race([Promise.resolve().then(()=>{if(closed)throw Error('Guest callable dispatch is closed');return transport.next(operation)}),cancellation]).then(event=>{
          if(event?.type==='result')return event.value
          if(event?.type==='error')throw Error(String(event.message))
          if(event?.type!=='callback'||!Number.isSafeInteger(event.id)||seen.has(event.id)||seen.size>=1024||!Array.isArray(event.args))throw Error('Invalid native callable callback request')
          seen.add(event.id)
          let reply
          try{
            const callback=callbacks[event.method]
            if(!allowed.has(event.method)||typeof callback!=='function')throw Error('Unknown native callable callback: '+event.method)
            // Ownership is causal, not process-global. Unrelated jobs may start
            // work while this callback is pending, but a callback cannot await
            // work queued behind its own synchronous native reply.
            const invokeCallback=()=>Reflect.apply(callback,undefined,event.args)
            const value=callbackScope?callbackScope.run({operation,callback:event.id},invokeCallback):invokeCallback()
            if(event.method==='onWarn'||event.method==='onDebug'){
              // Native ignores these return values, but failures remain observable.
              if(value&&typeof value.then==='function')Promise.resolve(value).catch(report)
              reply={type:'undefined'}
            }else{
              if(value&&typeof value.then==='function'){
                Promise.resolve(value).catch(report)
                throw Error('Native callable resolver callback returned a Promise')
              }
              reply=encode(value)
            }
          }catch(error){reply={type:'error',message:String(error)}}
          transport.reply(operation,event.id,reply)
          return pump()
        })
      }
      return pump().finally(()=>{
        active.delete(operation)
        try{transport.finish(operation)}finally{vacate(scoped)}
      })
      }
      // Keep one credit available for a bundler callback whose parent may be
      // blocking all ordinary operations on the native compiler queue.
      if(eligible(scoped)){occupy(scoped);return begin()}
      // Install this continuation in the caller's async context. The finishing
      // operation only grants a slot, it never executes another caller's work.
      return new Promise((resolve,reject)=>waiting.push({handle,scoped,resolve,reject})).then(begin,error=>{releaseReservation();throw error})
    },
    close(){
      if(closed)return
      closed=true;records.clear()
      for(const entry of waiting.splice(0))entry.reject(Error('Guest callable dispatch is closed'))
      for(const [operation,reject]of active){
        reject(Error('Guest callable dispatch is closed'))
        try{transport.cancel(operation)}catch(error){report(error)}
      }
      active.clear()
    },
  }
}
