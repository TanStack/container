export const sandboxDatabaseName='tanstack-sandbox-spike'
export const sandboxDatabaseVersion=4

export function openSandboxDatabase(signal?:AbortSignal):Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return}
    const request=indexedDB.open(sandboxDatabaseName,sandboxDatabaseVersion)
    let abandoned=false
    const abort=()=>{abandoned=true;reject(signal!.reason)}
    const cleanup=()=>signal?.removeEventListener('abort',abort)
    signal?.addEventListener('abort',abort,{once:true})
    request.onupgradeneeded=()=>{
      const db=request.result
      if(abandoned){request.transaction?.abort();return}
      if(!db.objectStoreNames.contains('checkpoints'))db.createObjectStore('checkpoints')
      if(!db.objectStoreNames.contains('checkpoint-manifests'))db.createObjectStore('checkpoint-manifests')
      if(!db.objectStoreNames.contains('checkpoint-blobs'))db.createObjectStore('checkpoint-blobs')
      if(!db.objectStoreNames.contains('package-cache')){
        const store=db.createObjectStore('package-cache',{keyPath:'id'})
        store.createIndex('kind-used',['kind','used'])
      }
      const store=request.transaction!.objectStore('package-cache')
      if(!store.indexNames.contains('kind-used-bytes'))store.createIndex('kind-used-bytes',['kind','used','bytes'])
    }
    request.onsuccess=()=>{
      cleanup()
      if(abandoned){request.result.close();return}
      request.result.onversionchange=()=>request.result.close()
      resolve(request.result)
    }
    request.onerror=()=>{cleanup();reject(request.error)}
    request.onblocked=()=>{cleanup();abandoned=true;reject(new Error('Sandbox database is blocked'))}
  })
}
