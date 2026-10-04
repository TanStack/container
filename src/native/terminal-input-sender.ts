/** One pending chunk per command, acknowledged when the receiver's reader takes it. */
export class NativeTerminalInputSender {
  #closed=false
  #sequence=0
  #pending:{id:number;resolve:()=>void;reject:(error:Error)=>void}|undefined
  constructor(private port:MessagePort){
    port.addEventListener('message',({data})=>{
      const pending=this.#pending
      if(!pending||data?.type!=='consumed'||data.id!==pending.id)return
      this.#pending=undefined;pending.resolve()
    })
    port.start()
  }
  write(value:string|Uint8Array):Promise<void>{
    if(this.#closed)return Promise.reject(Error('Terminal input is closed'))
    if(this.#pending)return Promise.reject(Error('Wait for the pending terminal input write'))
    const bytes=typeof value==='string'?new TextEncoder().encode(value):value
    if(!(bytes instanceof Uint8Array)||bytes.byteLength===0||bytes.byteLength>65536)
      return Promise.reject(Error('Invalid terminal input chunk'))
    const id=++this.#sequence
    return new Promise((resolve,reject)=>{
      this.#pending={id,resolve,reject}
      try{this.port.postMessage({type:'data',id,bytes})}
      catch(error){this.#pending=undefined;reject(error)}
    })
  }
  close(){
    this.#closed=true
    const pending=this.#pending;this.#pending=undefined
    pending?.reject(Error('Terminal input is closed'))
  }
}
