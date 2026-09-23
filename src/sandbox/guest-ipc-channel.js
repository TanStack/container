export function attachIPC(target,pid,mode,host,Buffer,nextTick,encodeIPC,decodeIPC){
  target.connected=true
  let done=false
  target.send=function(message,handle,options,callback){
    if(typeof handle==='function'){callback=handle;handle=undefined}
    else if(typeof options==='function')callback=options
    if(handle!==undefined&&handle!==null)throw Object.assign(Error('IPC handle transfer is unsupported'),{code:'ERR_UNSUPPORTED_OPERATION'})
    if(message===undefined||typeof message==='function'||typeof message==='symbol')throw new TypeError('Invalid IPC message')
    const encoded=encodeIPC(message,mode),bytes=Buffer.from(encoded,'utf8')
    let writable
    try{writable=host.proc.call('ipcSend',pid,Array.from(bytes))}
    catch(error){nextTick(()=>callback?callback(error):target.emit('error',error));return false}
    if(callback)nextTick(()=>callback(null))
    return writable
  }
  target.disconnect=function(){
    if(!target.connected){nextTick(()=>target.emit('error',Object.assign(Error('IPC channel is disconnected'),{code:'ERR_IPC_DISCONNECTED'})));return}
    host.proc.call('ipcDisconnect',pid);target.connected=false
  }
  const pump=async()=>{
    try{for(;;){
      const bytes=await host.proc.ipcNext(pid)
      if(bytes===null)break
      globalThis[Symbol.for('web-container:task-queue')].task(target.emit,target,['message',decodeIPC(Buffer.from(bytes).toString('utf8'),mode),undefined])
    }}finally{if(!done){done=true;target.connected=false;globalThis[Symbol.for('web-container:task-queue')].task(target.emit,target,['disconnect'])}}
  }
  target._ipcDone=new Promise(resolve=>nextTick(()=>resolve(pump())))
  target._ipcDone.catch(error=>host.reportError(error))
}
