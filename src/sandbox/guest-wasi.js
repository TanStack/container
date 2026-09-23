const ERRNO_SUCCESS=0,ERRNO_BADF=8,ERRNO_FAULT=21,ERRNO_INVAL=28
class WASIExit extends Error {constructor(code){super('WASI exited with status '+code);this.code=code}}
const invalid=(message,code='ERR_INVALID_ARG_VALUE')=>Object.assign(new TypeError(message),{code})

export class WASI {
  #args
  #env
  #memory
  #returnOnExit
  #started=false
  constructor(options={}){
    if(options===null||typeof options!=='object')throw invalid('WASI options must be an object','ERR_INVALID_ARG_TYPE')
    if(options.version!=='preview1')throw invalid('WASI version must be preview1')
    this.#args=(options.args??[]).map(String)
    this.#env=Object.entries(options.env??{}).map(([key,value])=>key+'='+String(value))
    this.#returnOnExit=options.returnOnExit===true
    const memory=()=>{
      if(!(this.#memory instanceof WebAssembly.Memory))throw new TypeError('WASI is not bound to an instance memory')
      return this.#memory
    }
    const view=()=>new DataView(memory().buffer)
    const bytes=()=>new Uint8Array(memory().buffer)
    const files=createWASIFileSystem(fs,options.preopens??{},memory)
    const clockNowNs=id=>id===0?BigInt(Date.now())*1000000n:id===1?BigInt(Math.trunc(performance.now()*1000000)):undefined
    const polling=createWASIPoll({
      getMemory:memory,
      clockNowNs,
      wait:typeof globalThis.__qjsFiberWait==='function'?ms=>globalThis.__qjsFiberWait(ms):undefined,
      // Standard streams do not yet expose readiness through this bridge.
      descriptor:(fd,type)=>fd>=0&&fd<=2?{error:58}:files.poll(fd,type),
    })
    const stringsSize=values=>values.reduce((sum,value)=>sum+new TextEncoder().encode(value).length+1,0)
    const writeStrings=(values,pointers,data)=>{try{const dataView=view(),target=bytes(),encoder=new TextEncoder();let offset=data;for(let index=0;index<values.length;index++){const value=encoder.encode(values[index]);dataView.setUint32(pointers+index*4,offset,true);target.set(value,offset);target[offset+value.length]=0;offset+=value.length+1}return ERRNO_SUCCESS}catch{return ERRNO_FAULT}}
    this.wasiImport={
      ...files.imports,
      ...polling,
      args_sizes_get:(count,size)=>{try{view().setUint32(count,this.#args.length,true);view().setUint32(size,stringsSize(this.#args),true);return ERRNO_SUCCESS}catch{return ERRNO_FAULT}},
      args_get:(pointers,data)=>writeStrings(this.#args,pointers,data),
      environ_sizes_get:(count,size)=>{try{view().setUint32(count,this.#env.length,true);view().setUint32(size,stringsSize(this.#env),true);return ERRNO_SUCCESS}catch{return ERRNO_FAULT}},
      environ_get:(pointers,data)=>writeStrings(this.#env,pointers,data),
      fd_write:(fd,iovs,iovsLength,written)=>{if(fd!==1&&fd!==2)return files.imports.fd_write(fd,iovs,iovsLength,written);try{const dataView=view(),target=bytes(),chunks=[];let total=0;for(let index=0;index<iovsLength;index++){const pointer=dataView.getUint32(iovs+index*8,true),length=dataView.getUint32(iovs+index*8+4,true);if(pointer+length>target.length)return ERRNO_FAULT;chunks.push(target.slice(pointer,pointer+length));total+=length}const output=new Uint8Array(total);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length}(fd===1?process.stdout:process.stderr).write(output);dataView.setUint32(written,total,true);return ERRNO_SUCCESS}catch{return ERRNO_FAULT}},
      proc_exit:code=>{code=Number(code)>>>0;files.close();if(this.#returnOnExit)throw new WASIExit(code);process.exit(code)},
      clock_time_get:(id,_precision,result)=>{try{let nanoseconds;if(id===0)nanoseconds=BigInt(Date.now())*1000000n;else if(id===1)nanoseconds=BigInt(Math.trunc(performance.now()*1000000));else return ERRNO_INVAL;view().setBigUint64(result,nanoseconds,true);return ERRNO_SUCCESS}catch{return ERRNO_FAULT}},
      random_get:(pointer,length)=>{try{const target=bytes();if(pointer+length>target.length)return ERRNO_FAULT;for(let offset=0;offset<length;offset+=65536)crypto.getRandomValues(target.subarray(pointer+offset,pointer+Math.min(length,offset+65536)));return ERRNO_SUCCESS}catch{return ERRNO_FAULT}},
    }
  }
  getImportObject(){return {wasi_snapshot_preview1:this.wasiImport}}
  #bind(instance){
    if(!(instance instanceof WebAssembly.Instance))throw invalid('Expected a WebAssembly.Instance','ERR_INVALID_ARG_TYPE')
    const memory=instance.exports.memory
    if(!(memory instanceof WebAssembly.Memory))throw new TypeError('WASI instance must export memory')
    this.#memory=memory
  }
  initialize(instance){
    if(this.#started)throw new Error('WASI instance has already started')
    this.#bind(instance)
    if(typeof instance.exports._start==='function')throw new TypeError('WASI initialize does not accept a _start export')
    this.#started=true
    if(instance.exports._initialize!==undefined&&typeof instance.exports._initialize!=='function')throw new TypeError('WASI _initialize export must be a function')
    instance.exports._initialize?.()
  }
  start(instance){
    if(this.#started)throw new Error('WASI instance has already started')
    this.#bind(instance);this.#started=true
    if(typeof instance.exports._start!=='function')throw new TypeError('WASI start requires a _start export')
    try{instance.exports._start();return 0}catch(error){if(error instanceof WASIExit)return error.code;throw error}
  }
}
export default {WASI}
import fs from 'node:fs'
import {createWASIFileSystem} from './guest-wasi-files.js'
import {createWASIPoll} from './guest-wasi-poll.js'
