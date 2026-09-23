const DEFAULT_ROOT='/project/node_modules/.vite'
const DEFAULT_LIMITS=Object.freeze({maxEntries:256,maxHashFileBytes:1024*1024,maxHashBytes:4*1024*1024})

const errorRecord=(operation,path,error)=>({
  operation,
  path,
  name:error instanceof Error?error.name:'Error',
  message:error instanceof Error?error.message:String(error),
  ...((error&&typeof error==='object'&&typeof error.code==='string')?{code:error.code}:{}),
})

async function sha256(bytes){
  if(!globalThis.crypto?.subtle)return undefined
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes)
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('')
}

/**
 * Capture Vite's dependency optimizer files without running code in the guest.
 * This is diagnostic evidence only. It never requests a writable file lease.
 */
export async function traceOptimizerFiles(kernel,{root=DEFAULT_ROOT,...inputLimits}={}){
  const limits={...DEFAULT_LIMITS,...inputLimits}
  for(const [name,value] of Object.entries(limits)){
    if(!Number.isSafeInteger(value)||value<0)throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  const result={root,present:true,truncated:false,limits,entries:[],errors:[]}
  let session
  try{
    session=await kernel.openFileSession({writable:false})
    let listed
    try{listed=await session.call('readdir',[root,{recursive:true,withFileTypes:true}])}
    catch(error){
      result.present=false
      result.errors.push(errorRecord('readdir',root,error))
      return result
    }
    if(!Array.isArray(listed))throw new TypeError('Optimizer directory listing was not an array')
    const ordered=listed.map(entry=>({
      path:root+'/'+String(entry.relativePath??entry.name??''),
      kind:entry.kind,
    })).filter(entry=>entry.path!==root+'/').sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
    result.truncated=ordered.length>limits.maxEntries
    let remainingHashBytes=limits.maxHashBytes
    for(const item of ordered.slice(0,limits.maxEntries)){
      const entry={path:item.path,kind:item.kind}
      try{
        const stat=await session.call('lstat',[item.path])
        entry.kind=stat.kind
        entry.size=stat.size
        entry.mode=stat.mode
        entry.mtimeMs=stat.mtimeMs
        if(stat.kind==='file'){
          if(stat.size>limits.maxHashFileBytes)entry.hashSkipped='file-limit'
          else if(stat.size>remainingHashBytes)entry.hashSkipped='total-limit'
          else if(!globalThis.crypto?.subtle)entry.hashSkipped='webcrypto-unavailable'
          else try{
            const bytes=await kernel.readFile(item.path)
            if(!(bytes instanceof Uint8Array))throw new TypeError('File read did not return Uint8Array')
            if(bytes.byteLength!==stat.size)throw new Error(`File size changed during snapshot, expected ${stat.size}, received ${bytes.byteLength}`)
            entry.sha256=await sha256(bytes)
            remainingHashBytes-=bytes.byteLength
          }catch(error){result.errors.push(errorRecord('hash',item.path,error))}
        }
      }catch(error){result.errors.push(errorRecord('lstat',item.path,error))}
      result.entries.push(entry)
    }
    return result
  }catch(error){
    result.errors.push(errorRecord('snapshot',root,error))
    return result
  }finally{
    if(session)try{await session.close()}catch(error){result.errors.push(errorRecord('close',root,error))}
  }
}
