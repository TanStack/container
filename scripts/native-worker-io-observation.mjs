// Opt-in test metadata only. No extra messages, reads, promises or body access.
export function installNativeWorkerIOObservation({ownerOrigin,parentOrigin,maxEvents=256,maxPending=128}){
  if(location.origin!==ownerOrigin)return
  if(!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>512||!Number.isSafeInteger(maxPending)||maxPending<1||maxPending>256)
    throw new TypeError('Invalid observation limits')
  const state={rows:[],dropped:0,pendingDropped:0},workers=new WeakMap(),ownerPorts=new WeakSet()
  const workerPending=new Map(),ownerPending=new Map(),sockets=new Map()
  const started=performance.now(),operations=new Set(['start','ports','connect','read','write','end','closeSocket'])
  let nextWorker=0
  const safe=callback=>{try{return callback()}catch{}}
  const now=()=>Math.round(performance.now()-started)
  const record=row=>safe(()=>{
    const event={...row,elapsedMs:now()}
    state.rows.push(event)
    if(state.rows.length>maxEvents){state.rows.shift();state.dropped++}
    console.info('NATIVE_WORKER_IO '+JSON.stringify(event))
  })
  const pending=(map,key,row)=>{
    if(map.size<maxPending)map.set(key,{...row,elapsedMs:now()})
    else state.pendingDropped++
  }
  const snapshot=scope=>record({kind:'snapshot',scope,dropped:state.dropped,pendingDropped:state.pendingDropped,
    pendingWorker:[...workerPending.values()],pendingOwner:[...ownerPending.values()],sockets:[...sockets.values()]})
  const attachWorker=worker=>{
    let id=workers.get(worker)
    if(id)return id
    id=++nextWorker;workers.set(worker,id)
    worker.addEventListener('message',event=>safe(()=>{
      const data=event.data,key=id+':'+data?.id,request=workerPending.get(key)
      if(!request||typeof data.ok!=='boolean')return
      workerPending.delete(key)
      const socketId=Number.isSafeInteger(data.value?.socketId)?data.value.socketId:request.socketId
      const row={kind:'worker-response',worker:id,id:data.id,operation:request.operation,ok:data.ok,
        socketId,waitMs:now()-request.elapsedMs}
      if(request.operation==='read'&&['data','end','close','error'].includes(data.value?.type)){
        row.socketEvent=data.value.type
        if(Number.isSafeInteger(data.value.bytes?.byteLength))row.bytes=data.value.bytes.byteLength
      }
      if(request.operation==='connect'&&data.ok&&socketId!==undefined&&sockets.size<64)
        sockets.set(id+':'+socketId,{worker:id,socketId})
      if(request.operation==='closeSocket'&&data.ok)sockets.delete(id+':'+socketId)
      record(row)
    }))
    return id
  }
  const postWorker=Worker.prototype.postMessage
  Worker.prototype.postMessage=function(data){
    let key
    safe(()=>{
      if(!operations.has(data?.operation)||!Number.isSafeInteger(data.id)||data.id<1)return
      const worker=attachWorker(this)
      key=worker+':'+data.id
      const row={worker,id:data.id,operation:data.operation}
      if(Number.isSafeInteger(data.socketId))row.socketId=data.socketId
      if(data.operation==='write'&&Number.isSafeInteger(data.bytes?.byteLength))row.bytes=data.bytes.byteLength
      pending(workerPending,key,row);record({kind:'worker-request',...row})
    })
    try{return Reflect.apply(postWorker,this,arguments)}
    catch(error){safe(()=>{workerPending.delete(key);record({kind:'worker-send-threw'})});throw error}
  }
  addEventListener('message',event=>safe(()=>{
    if(event.origin!==parentOrigin||event.source!==parent||event.data?.protocol!=='native-owner-v1'||
      event.data.type!=='connect'||event.ports?.length!==1)return
    const port=event.ports[0]
    if(ownerPorts.has(port))return
    ownerPorts.add(port)
    // Installed before the application listener, but does not start the port.
    port.addEventListener('message',event=>safe(()=>{
      const data=event.data
      if(data?.protocol!=='native-owner-v1'||data.type!=='request'||!Number.isSafeInteger(data.id)||
        !['start','restart','fetch','dispose'].includes(data.operation))return
      const row={id:data.id,operation:data.operation}
      if(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(data.method))row.method=data.method
      pending(ownerPending,data.id,row);record({kind:'owner-request',...row})
      if(data.operation==='dispose')snapshot('before owner handles dispose')
    }))
  }))
  const postPort=MessagePort.prototype.postMessage
  MessagePort.prototype.postMessage=function(data){
    safe(()=>{
      if(!ownerPorts.has(this)||data?.protocol!=='native-owner-v1'||data.type!=='response')return
      const request=ownerPending.get(data.id)
      if(!request)return
      ownerPending.delete(data.id)
      const row={kind:'owner-response',id:data.id,operation:request.operation,ok:data.ok,waitMs:now()-request.elapsedMs}
      if(request.operation==='fetch'&&data.ok){row.status=data.value?.status;row.hasBody=!!data.value?.hasBody}
      record(row)
    })
    return Reflect.apply(postPort,this,arguments)
  }
  Object.defineProperty(globalThis,'__nativeWorkerIOObservation',{value:state})
}
