export const sandboxDatabaseName='tanstack-sandbox-spike'
export const sandboxDatabaseVersion=4

export function openSandboxDatabase():Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(sandboxDatabaseName,sandboxDatabaseVersion)
    let abandoned=false
    request.onupgradeneeded=()=>{
      const db=request.result
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
      if(abandoned){request.result.close();return}
      request.result.onversionchange=()=>request.result.close()
      resolve(request.result)
    }
    request.onerror=()=>reject(request.error)
    request.onblocked=()=>{abandoned=true;reject(new Error('Sandbox database is blocked'))}
  })
}
