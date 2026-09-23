import type {WorkspaceSnapshot} from '../../src/sandbox/files'

/** Browser-evaluable helpers. Keep runtime dependencies inside each function. */
export async function startSnapshotStore(input:{operation:'save'|'load'|'delete';snapshot?:WorkspaceSnapshot}):Promise<WorkspaceSnapshot|undefined>{
  const database=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('sdk-start-counter-acceptance',1)
    request.onupgradeneeded=()=>request.result.createObjectStore('snapshots')
    request.onerror=()=>reject(request.error)
    request.onblocked=()=>reject(Error('Acceptance snapshot database is blocked'))
    request.onsuccess=()=>resolve(request.result)
  })
  try{
    return await new Promise<WorkspaceSnapshot|undefined>((resolve,reject)=>{
      const transaction=database.transaction('snapshots',input.operation==='load'?'readonly':'readwrite')
      const store=transaction.objectStore('snapshots')
      let result:WorkspaceSnapshot|undefined
      transaction.oncomplete=()=>resolve(result)
      transaction.onabort=()=>reject(transaction.error??Error('Acceptance snapshot transaction aborted'))
      transaction.onerror=()=>reject(transaction.error??Error('Acceptance snapshot transaction failed'))
      if(input.operation==='save'){
        if(!input.snapshot){transaction.abort();return}
        // IndexedDB structured clone preserves Uint8Array files and metadata.
        // JSON conversion would corrupt the public kernel snapshot format.
        store.put(input.snapshot,'counter')
      }else if(input.operation==='delete')store.delete('counter')
      else{
        const request=store.get('counter')
        request.onsuccess=()=>{result=request.result}
      }
    })
  }finally{database.close()}
}

export async function fingerprintStartWorkspace(snapshot:WorkspaceSnapshot){
  const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('')
  const entries:Array<[string,string]>=[]
  let bytes=0,packageFiles=0,cacheFiles=0
  for(const path of Object.keys(snapshot.files).sort()){
    const contents=snapshot.files[path]
    if(!(contents instanceof Uint8Array))throw Error('Snapshot file is not a Uint8Array: '+path)
    entries.push([path,hex(await crypto.subtle.digest('SHA-256',contents.slice().buffer))])
    bytes+=contents.byteLength
    if(path.startsWith('/project/node_modules/'))packageFiles++
    if(path.startsWith('/project/node_modules/.vite/'))cacheFiles++
  }
  const ordered=(record:Record<string,unknown>)=>Object.entries(record).sort(([a],[b])=>a<b?-1:a>b?1:0)
  const metadata={
    version:snapshot.version,files:entries,
    directories:'directories'in snapshot?[...snapshot.directories].sort():[],
    symlinks:'symlinks'in snapshot?ordered(snapshot.symlinks):[],
    fileModes:'fileModes'in snapshot?ordered(snapshot.fileModes):[],
    directoryModes:'directoryModes'in snapshot?ordered(snapshot.directoryModes):[],
  }
  return {sha256:hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(metadata)))),files:entries.length,bytes,packageFiles,cacheFiles}
}
