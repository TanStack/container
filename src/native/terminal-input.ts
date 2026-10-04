/** One terminal command's bounded stdin channel. The port is transferred to the project worker. */
export class NativeTerminalInput {
  #chunks:Array<{bytes:Uint8Array;id?:number}>=[]
  #waiters:Array<{resolve:(value:Uint8Array|null)=>void;reject:(error:Error)=>void}>=[]
  #buffered=0
  #ended=false
  #error:Error|undefined
  #portClosed=false
  constructor(private port?:MessagePort,private onResize?:(columns:number,rows:number)=>void){
    if(!port){this.#ended=true;return}
    port.onmessage=({data})=>{
      if(this.#ended)return
      if(data?.type==='end'){this.end();return}
      if(data?.type==='resize'){
        const {columns,rows}=data
        if(!Number.isSafeInteger(columns)||columns<1||columns>1000||!Number.isSafeInteger(rows)||rows<1||rows>1000){
          this.#fail(Error('Invalid terminal size'));return
        }
        this.onResize?.(columns,rows)
        return
      }
      if(data?.type!=='data'||!(data.bytes instanceof Uint8Array)||data.bytes.byteLength===0||data.bytes.byteLength>65536){
        this.#fail(Error('Invalid terminal input chunk'));return
      }
      if(data.id!==undefined&&(!Number.isSafeInteger(data.id)||data.id<1)){
        this.#fail(Error('Invalid terminal input acknowledgement id'));return
      }
      if(this.#buffered+data.bytes.byteLength>1024*1024){this.#fail(Error('Terminal input limit exceeded'));return}
      const waiter=this.#waiters.shift()
      if(waiter){waiter.resolve(data.bytes);this.#acknowledge(data.id)}
      else{this.#chunks.push({bytes:data.bytes,id:data.id});this.#buffered+=data.bytes.byteLength}
    }
    port.onmessageerror=()=>this.#fail(Error('Terminal input could not be decoded'))
    port.start()
  }
  read():Promise<Uint8Array|null>{
    if(this.#error)return Promise.reject(this.#error)
    const chunk=this.#chunks.shift()
    if(chunk){
      this.#buffered-=chunk.bytes.byteLength;this.#acknowledge(chunk.id)
      if(this.#ended&&this.#chunks.length===0)this.#closePort()
      return Promise.resolve(chunk.bytes)
    }
    if(this.#ended)return Promise.resolve(null)
    return new Promise((resolve,reject)=>this.#waiters.push({resolve,reject}))
  }
  end(){
    if(this.#ended)return
    this.#ended=true
    for(const waiter of this.#waiters.splice(0)){
      if(this.#error)waiter.reject(this.#error)
      else waiter.resolve(null)
    }
    if(this.#chunks.length===0)this.#closePort()
  }
  #fail(error:Error){this.#error=error;this.end()}
  #acknowledge(id:number|undefined){if(id!==undefined)this.port?.postMessage({type:'consumed',id})}
  #closePort(){if(!this.#portClosed){this.#portClosed=true;this.port?.close()}}
  close(){this.end();this.#chunks.length=0;this.#buffered=0;this.#closePort()}
}
