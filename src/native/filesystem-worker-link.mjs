const key=Symbol.for('tanstack-container:filesystem-connection-v1')
export const FILESYSTEM_BOOTSTRAP='native-filesystem-bootstrap'
export const FILESYSTEM_ATTACH='native-filesystem-control-attach'
export const FILESYSTEM_DETACH='native-filesystem-control-detach'

export function installNativeFilesystemConnection(connection,scope=globalThis){
  if(!connection?.control||typeof connection.control.postMessage!=='function'||
    typeof connection.id!=='string'||!connection.id)throw TypeError('Invalid filesystem connection')
  if(scope[key])throw Error('Filesystem connection is already installed')
  Object.defineProperty(scope,key,{value:Object.freeze({...connection}),writable:false,configurable:false})
}
export function getNativeFilesystemConnection(scope=globalThis){return scope[key]}

// The owner receives the child control port first. Child requests never need
// the parent's event loop, even while the parent is blocked in WASM.
export function linkNativeFilesystemWorker(worker,connection=getNativeFilesystemConnection()){
  if(!connection)return undefined
  const id=connection.id+'/'+crypto.randomUUID()
  const {port1,port2}=new MessageChannel()
  try{
    connection.control.postMessage({type:FILESYSTEM_ATTACH,id,port:port1},[port1])
    worker.postMessage({type:FILESYSTEM_BOOTSTRAP,id,control:port2},[port2])
  }catch(error){
    port1.close();port2.close()
    connection.control.postMessage({type:FILESYSTEM_DETACH,id})
    throw error
  }
  let closed=false
  return {id,dispose(){
    if(closed)return;closed=true
    connection.control.postMessage({type:FILESYSTEM_DETACH,id})
  }}
}

export function receiveNativeFilesystemBootstrap(target=globalThis,timeoutMs=30000){
  const queued=target[Symbol.for('tanstack-container:filesystem-bootstrap-v1')]
  if(queued)return Promise.resolve(queued)
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);target.removeEventListener('message',message)}
    const message=event=>{
      if(event.data?.type!==FILESYSTEM_BOOTSTRAP)return
      cleanup();resolve(event.data)
    }
    const timer=setTimeout(()=>{cleanup();reject(Error('Filesystem bootstrap timed out'))},timeoutMs)
    target.addEventListener('message',message)
  })
}
