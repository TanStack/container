import {FILESYSTEM_BOOTSTRAP,installNativeFilesystemConnection} from './filesystem-worker-link.mjs'
import {createWasiFilesystemEndpoint} from './wasi-filesystem-service.mjs'
import {connectWasiFilesystemPort} from './wasi-fs-transport.mjs'

// onCreateWorker posts the connection before NAPI's load message. The message
// listener runs synchronously, so WASI preopens never use a local file store.
export function installWasiFilesystemBootstrap(codec,target=globalThis){
  const listener=({data})=>{
    if(data?.type!==FILESYSTEM_BOOTSTRAP)return
    installNativeFilesystemConnection(data)
    const endpoint=createWasiFilesystemEndpoint(data.control,data.id,{codec})
    connectWasiFilesystemPort(endpoint.port)
    target.removeEventListener('message',listener)
  }
  target.addEventListener('message',listener)
}
