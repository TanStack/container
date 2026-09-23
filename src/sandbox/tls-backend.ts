import {runtimeAssetURL} from './runtime-assets'
export const TLS_WANT_READ=-0x6900,TLS_WANT_WRITE=-0x6880,TLS_CRYPTO_IN_PROGRESS=-0x7000,TLS_CLOSE_NOTIFY=-0x7880
export type TLSModule={HEAPU8:Uint8Array;[name:`_tls_${string}`]:(...args:number[])=>number}
type Module=TLSModule
type Owner={closed:boolean;ready:Promise<void>;module?:Module;scratch:number;maxBytes:number}
type Handle={owner:number;record:Owner;local:number}
export type TLSSettings={server?:boolean;ca?:string|Uint8Array;caMode?:'strict'|'node';cert?:string|Uint8Array;key?:string|Uint8Array;servername?:string;minVersion?:12|13;maxVersion?:12|13;verification?:'none'|'optional'|'required'}
const failure=(code:string,message:string)=>Object.assign(Error(message),{code})
const encoder=new TextEncoder(),decoder=new TextDecoder()
let defaultLoader:Promise<()=>Module>|undefined
const defaultFactory=async():Promise<Module>=>{defaultLoader??=loadTLSFactory();return (await defaultLoader)()}

/** Load once, then initialize synchronously for Node's setup APIs. */
export async function loadTLSFactory(assetBaseURL?:string):Promise<()=>Module>{
  const base=runtimeAssetURL('tls-runtime/',assetBaseURL)
  const path=new URL('tls.mjs',base).href
  const [{default:create},response]=await Promise.all([import(/* @vite-ignore */path),fetch(new URL('tls.wasm',base))])
  if(!response.ok)throw Error('TLS runtime download failed: '+response.status)
  const wasmBinary=new Uint8Array(await response.arrayBuffer())
  return ()=>{
    let initialized=false
    // MODULARIZE wraps even synchronous builds in an async function. The
    // supported runtime callback proves that setup finished before returning.
    const options={wasmBinary,onRuntimeInitialized(){initialized=true}}
    const completion=create(options)
    if(!initialized){
      void Promise.resolve(completion).catch(()=>{})
      throw Error('TLS runtime did not initialize synchronously')
    }
    return options as unknown as Module
  }
}

/** Trusted host backend. Owner IDs come from the process manager, never guests. */
export class TLSBackend {
  #owners=new Map<number,Owner>()
  #retiring=new Set<Owner>()
  #handles=new Map<number,Handle>()
  #next=1
  constructor(private factory:()=>Promise<Module>|Module=defaultFactory,private maxOwners=4,private syncFactory?:()=>Module){
    if(!Number.isInteger(maxOwners)||maxOwners<1||maxOwners>32)throw failure('EINVAL','Invalid TLS owner limit')
  }
  #reserve(owner:number,maxBytes:number,maxConnections:number){
    if(!Number.isSafeInteger(owner)||owner<1||!Number.isInteger(maxBytes)||maxBytes<65536||maxBytes>32*1024*1024||!Number.isInteger(maxConnections)||maxConnections<1||maxConnections>32)throw failure('EINVAL','Invalid TLS owner limits')
    if(this.#owners.has(owner))throw failure('EBUSY','TLS owner already exists')
    if(this.#owners.size+this.#retiring.size>=this.maxOwners)throw failure('EMFILE','TLS owner limit exceeded')
    const record:Owner={closed:false,ready:Promise.resolve(),scratch:0,maxBytes}
    this.#owners.set(owner,record)
    return record
  }
  #initialize(record:Owner,module:Module,maxConnections:number){
    record.module=module
    this.#check(module,module._tls_initialize(record.maxBytes,maxConnections))
    record.scratch=module._tls_allocate(65536)
    if(!record.scratch)throw failure('ERR_RESOURCE_LIMIT','TLS scratch allocation exceeded the owner budget')
  }
  createOwnerSync(owner:number,{maxBytes=4*1024*1024,maxConnections=32}={}){
    if(!this.syncFactory)throw failure('ERR_UNSUPPORTED_OPERATION','Synchronous TLS factory is unavailable')
    const record=this.#reserve(owner,maxBytes,maxConnections)
    try{this.#initialize(record,this.syncFactory(),maxConnections)}
    catch(error){this.#dispose(record);this.#owners.delete(owner);throw error}
  }
  async createOwner(owner:number,{maxBytes=4*1024*1024,maxConnections=32}={}){
    const record=this.#reserve(owner,maxBytes,maxConnections)
    record.ready=(async()=>{
      const module=record.module=await this.factory()
      if(record.closed)return
      this.#initialize(record,module,maxConnections)
    })().catch(error=>{
      this.#dispose(record)
      if(this.#owners.get(owner)===record)this.#owners.delete(owner)
      throw error
    })
    await record.ready
    if(record.closed)throw failure('ECANCELED','TLS owner closed during initialization')
  }
  #dispose(record:Owner){
    const module=record.module
    if(!module)return
    if(record.scratch)module._tls_deallocate(record.scratch)
    record.scratch=0
    const retained=module._tls_shutdown()
    record.module=undefined
    if(retained)throw failure('ERR_TLS_CLEANUP',`TLS owner retained ${retained} tracked bytes`)
  }
  async closeOwner(owner:number){
    const record=this.#owners.get(owner)
    if(!record)return
    record.closed=true;this.#owners.delete(owner);this.#retiring.add(record)
    for(const [id,handle] of this.#handles)if(handle.record===record)this.#handles.delete(id)
    await record.ready.catch(()=>{})
    this.#dispose(record)
    this.#retiring.delete(record)
  }
  #owner(owner:number){
    const record=this.#owners.get(owner)
    if(!record||record.closed||!record.module||!record.scratch)throw failure('EBADF','TLS owner is unavailable')
    return record
  }
  #handle(owner:number,id:number){
    const handle=this.#handles.get(id)
    if(!handle||handle.owner!==owner||this.#owners.get(owner)!==handle.record||handle.record.closed)throw failure('EBADF','TLS connection is unavailable to this owner')
    return {...handle,module:handle.record.module!}
  }
  #string(module:Module,pointer:number){
    if(!pointer)return ''
    const end=module.HEAPU8.indexOf(0,pointer)
    return decoder.decode(module.HEAPU8.subarray(pointer,end<0?pointer:end))
  }
  #check(module:Module,code:number){
    if(code<0&&![TLS_WANT_READ,TLS_WANT_WRITE,TLS_CRYPTO_IN_PROGRESS,TLS_CLOSE_NOTIFY].includes(code))
      throw Object.assign(failure('ERR_TLS_BACKEND',this.#string(module,module._tls_error(code))),{tlsCode:code})
    return code
  }
  open(owner:number,settings:TLSSettings){
    const record=this.#owner(owner),module=record.module!
    if(!settings||typeof settings!=='object')throw failure('EINVAL','Invalid TLS settings')
    if(settings.caMode!==undefined&&!['strict','node'].includes(settings.caMode))throw failure('EINVAL','Invalid TLS CA parsing mode')
    const {server=false,servername='',minVersion=12,maxVersion=13,verification=server?'none':'required'}=settings
    if(typeof server!=='boolean'||typeof servername!=='string'||servername.length>255||servername.includes('\0')||encoder.encode(servername).length>255||!server&&!servername||![12,13].includes(minVersion)||![12,13].includes(maxVersion)||minVersion>maxVersion||!['none','optional','required'].includes(verification))throw failure('EINVAL','Invalid TLS settings')
    if(this.#next>=Number.MAX_SAFE_INTEGER)throw failure('EMFILE','TLS handle space exhausted')
    const allocated:number[]=[]
    const input=(value:string|Uint8Array|undefined,maximum:number,pem=false)=>{
      if(value!==undefined&&typeof value!=='string'&&!(value instanceof Uint8Array))throw failure('EINVAL','Expected certificate bytes')
      if(value!==undefined&&value.length>maximum)throw failure('ERR_RESOURCE_LIMIT','TLS input exceeds its size limit')
      const bytes=typeof value==='string'?encoder.encode(value):value??new Uint8Array()
      if(bytes.length>maximum)throw failure('ERR_RESOURCE_LIMIT','TLS input exceeds its size limit')
      if(!bytes.length)return [0,0]
      const pointer=module._tls_allocate(bytes.length+1)
      if(!pointer)throw failure('ERR_RESOURCE_LIMIT','TLS input allocation exceeded the owner budget')
      allocated.push(pointer);module.HEAPU8.set(bytes,pointer);module.HEAPU8[pointer+bytes.length]=0
      const isPEM=pem&&decoder.decode(bytes.subarray(0,11))==='-----BEGIN '
      return [pointer,bytes.length+(isPEM?1:0)]
    }
    try{
      const ca=input(settings.ca,1048575,true),cert=input(settings.cert,1048575,true),key=input(settings.key,65535,true),hostname=input(servername,255)
      const open=settings.caMode==='node'?module._tls_open_node:module._tls_open
      const local=this.#check(module,open(server?1:0,...ca,...cert,...key,hostname[0],minVersion,maxVersion,['none','optional','required'].indexOf(verification)))
      if(local<=0)throw failure('ERR_TLS_BACKEND','TLS connection initialization did not complete')
      const id=this.#next++;this.#handles.set(id,{owner,record,local});return id
    }finally{for(const pointer of allocated)module._tls_deallocate(pointer)}
  }
  step(owner:number,id:number){const h=this.#handle(owner,id);return this.#check(h.module,h.module._tls_step(h.local))}
  feed(owner:number,id:number,bytes:Uint8Array){
    const h=this.#handle(owner,id);this.#bytes(bytes)
    h.module.HEAPU8.set(bytes,h.record.scratch)
    return this.#check(h.module,h.module._tls_feed(h.local,h.record.scratch,bytes.length))
  }
  write(owner:number,id:number,bytes:Uint8Array){
    const h=this.#handle(owner,id);this.#bytes(bytes)
    h.module.HEAPU8.set(bytes,h.record.scratch)
    return this.#check(h.module,h.module._tls_write(h.local,h.record.scratch,bytes.length))
  }
  #bytes(bytes:Uint8Array){if(!(bytes instanceof Uint8Array)||bytes.length>65536)throw failure('ERR_RESOURCE_LIMIT','TLS transfers are limited to 64 KiB')}
  drain(owner:number,id:number){
    const h=this.#handle(owner,id),length=this.#check(h.module,h.module._tls_drain(h.local,h.record.scratch,65536))
    return h.module.HEAPU8.slice(h.record.scratch,h.record.scratch+length)
  }
  read(owner:number,id:number){
    const h=this.#handle(owner,id),code=this.#check(h.module,h.module._tls_read(h.local,h.record.scratch,65536))
    return {code,bytes:code>0?h.module.HEAPU8.slice(h.record.scratch,h.record.scratch+code):new Uint8Array()}
  }
  eof(owner:number,id:number){const h=this.#handle(owner,id);return this.#check(h.module,h.module._tls_eof(h.local))}
  close(owner:number,id:number){const h=this.#handle(owner,id);return this.#check(h.module,h.module._tls_close(h.local))}
  destroy(owner:number,id:number){
    const h=this.#handle(owner,id);this.#check(h.module,h.module._tls_destroy(h.local));this.#handles.delete(id)
  }
  info(owner:number,id:number){const h=this.#handle(owner,id);return {verifyFlags:h.module._tls_verify(h.local)>>>0,protocol:this.#string(h.module,h.module._tls_protocol(h.local))}}
  stats(owner:number){const r=this.#owner(owner),m=r.module!;return {allocated:m._tls_allocated(),peak:m._tls_peak(),maxBytes:r.maxBytes,wasmMemoryBytes:m.HEAPU8.byteLength,connections:[...this.#handles.values()].filter(h=>h.record===r).length}}
}
