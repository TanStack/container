import {openSandboxDatabase} from '../sandbox/database'

const recordVersion=1
let lastUsed=0
export function packageCacheTimestamp(){lastUsed=Math.max(Date.now(),lastUsed+1);return lastUsed}
export type StoredPackageRecord=
  |{id:string;version:1;kind:'archive';key:string;value:ArrayBuffer;bytes:number;used:number}
  |{id:string;version:1;kind:'metadata';key:string;value:string;bytes:number;used:number}

function available(){return typeof indexedDB!=='undefined'}
function kindRange(kind:'archive'|'metadata'){return IDBKeyRange.bound([kind],[kind,[]])}
function valid(record:unknown):record is StoredPackageRecord{
  if(!record||typeof record!=='object')return false
  const value=record as Partial<StoredPackageRecord>
  return value.version===recordVersion&&(value.kind==='archive'||value.kind==='metadata')&&
    typeof value.id==='string'&&value.id===value.kind+':'+value.key&&typeof value.key==='string'&&
    typeof value.bytes==='number'&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&
    typeof value.used==='number'&&Number.isFinite(value.used)&&
    (value.kind==='archive'?value.value instanceof ArrayBuffer&&value.value.byteLength===value.bytes:typeof value.value==='string'&&new TextEncoder().encode(value.value).length===value.bytes)
}
async function databaseOperation<T>(run:(store:IDBObjectStore,resolve:(value:T)=>void)=>void):Promise<T>{
  const db=await openSandboxDatabase()
  try{return await new Promise<T>((resolve,reject)=>{
    const transaction=db.transaction('package-cache','readwrite'),store=transaction.objectStore('package-cache')
    let result:T,settled=false
    run(store,value=>{result=value;settled=true})
    transaction.oncomplete=()=>settled?resolve(result!):reject(new Error('Package cache operation did not produce a result'))
    transaction.onabort=()=>reject(transaction.error??new Error('Package cache transaction aborted'))
  })}finally{db.close()}
}
export async function loadPackageRecords(kind:'archive'|'metadata'):Promise<StoredPackageRecord[]>{
  if(!available())return []
  return databaseOperation((store,resolve)=>{
    const request=store.index('kind-used').getAll(kindRange(kind))
    request.onsuccess=()=>{
      const records:StoredPackageRecord[]=[]
      for(const candidate of request.result){
        if(valid(candidate)){if(candidate.kind===kind)records.push(candidate)}
        else if(candidate&&typeof candidate.id==='string')store.delete(candidate.id)
      }
      resolve(records)
    }
  })
}
export async function readPackageRecord(kind:'archive'|'metadata',key:string):Promise<StoredPackageRecord|undefined>{
  if(!available())return undefined
  return databaseOperation((store,resolve)=>{
    const request=store.get(kind+':'+key)
    request.onsuccess=()=>{
      if(valid(request.result)&&request.result.kind===kind){request.result.used=packageCacheTimestamp();store.put(request.result);resolve(request.result);return}
      if(request.result!==undefined)store.delete(kind+':'+key)
      resolve(undefined)
    }
  })
}
export async function deletePackageRecord(kind:'archive'|'metadata',key:string){
  if(!available())return
  await databaseOperation<void>((store,resolve)=>{store.delete(kind+':'+key);resolve()})
}
export async function writePackageRecord(record:StoredPackageRecord,maxBytes:number,maxEntries:number){
  if(!available()||record.bytes>maxBytes||maxEntries<1)return
  await databaseOperation<void>((store,resolve)=>{
    store.put(record)
    // Index keys contain the accounting fields, so eviction never clones archive
    // payloads. The transaction still makes insertion and eviction atomic.
    const records:{id:string;bytes:number;used:number}[]=[]
    const request=store.index('kind-used-bytes').openKeyCursor(kindRange(record.kind))
    request.onsuccess=()=>{
      const cursor=request.result
      if(cursor){
        const [,used,bytes]=cursor.key as [string,number,number]
        if(typeof cursor.primaryKey==='string'&&cursor.primaryKey.startsWith(record.kind+':')&&
          typeof used==='number'&&Number.isFinite(used)&&typeof bytes==='number'&&Number.isSafeInteger(bytes)&&bytes>=0)
          records.push({id:cursor.primaryKey,used,bytes})
        cursor.continue()
        return
      }
      records.sort((a,b)=>a.used-b.used||a.id.localeCompare(b.id))
      let bytes=records.reduce((sum,item)=>sum+item.bytes,0)
      while(records.length>maxEntries||bytes>maxBytes){const oldest=records.shift();if(!oldest)break;bytes-=oldest.bytes;store.delete(oldest.id)}
      resolve()
    }
  })
}
