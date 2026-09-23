import {installLockedPackages,PackageInstallCache} from '../../src/npm/install'
import {WorkspaceFiles} from '../../src/sandbox/files'

let sequence=0,sent=0
const pending=new Map<number,unknown>()
const emit=(event:unknown)=>{if(sent++<512)postMessage({event,at:performance.now(),pending:[...pending.values()]})}
const begin=(stage:string)=>{const id=++sequence;pending.set(id,{id,stage});emit({type:'begin',stage,id});return id}
const end=(id:number,error?:unknown)=>{pending.delete(id);emit({type:'end',id,error:error?String(error):undefined})}
const digest=crypto.subtle.digest.bind(crypto.subtle)
crypto.subtle.digest=(...args)=>{const id=begin('digest');const result=digest(...args);result.then(()=>end(id),error=>end(id,error));return result}
const open=indexedDB.open.bind(indexedDB)
indexedDB.open=(...args)=>{const id=begin('idb-open');const result=open(...args);result.addEventListener('success',()=>end(id));result.addEventListener('error',()=>end(id,result.error));result.addEventListener('blocked',()=>emit({type:'blocked',id}));return result}
const transaction=IDBDatabase.prototype.transaction
IDBDatabase.prototype.transaction=function(...args){const id=begin('idb-transaction');const result=Reflect.apply(transaction,this,args);result.addEventListener('complete',()=>end(id));result.addEventListener('abort',()=>end(id,result.error));return result}
const NativeDecompressionStream=DecompressionStream
globalThis.DecompressionStream=class extends NativeDecompressionStream{constructor(format:CompressionFormat){super(format);emit({type:'decompression-created'})}}
const read=ReadableStreamDefaultReader.prototype.read
ReadableStreamDefaultReader.prototype.read=function(){const id=begin('stream-read');const result=Reflect.apply(read,this,[]);result.then((value:ReadableStreamReadResult<Uint8Array>)=>{emit({type:'read-result',id,done:value.done,bytes:value.value?.byteLength});end(id)},(error:unknown)=>end(id,error));return result}
setInterval(()=>postMessage({heartbeat:true,at:performance.now(),pending:[...pending.values()]}),1000)
onmessage=async event=>{
  const files=new WorkspaceFiles({},128*1024*1024),cache=new PackageInstallCache()
  try{
    emit({type:'install-start'})
    await installLockedPackages(files,event.data,progress=>emit({type:'package-complete',...progress}),undefined,cache)
    const snapshot=files.snapshot()
    postMessage({done:true,files:Object.keys(snapshot.files),at:performance.now()})
  }catch(error){postMessage({done:true,error:String(error),at:performance.now()})}
}
emit({type:'worker-ready'})
