type OutputMessage={type:'native-thread-output';stream:'stdout'|'stderr';bytes:Uint8Array;outputId:number}

/** One acknowledged chunk at a time per Writable, including split large writes. */
export class NativeStdioTransport {
  #next=0
  #receipts=new Map<number,()=>void>()
  constructor(private send:(message:OutputMessage)=>void,private keepAlive:()=>()=>void){}
  write(stream:'stdout'|'stderr',bytes:Uint8Array,done:(error?:Error)=>void){
    const release=this.keepAlive()
    let offset=0
    const finish=(error?:Error)=>{try{done(error)}finally{release()}}
    const next=()=>{
      if(offset===bytes.byteLength){finish();return}
      const chunk=bytes.slice(offset,offset+65536)
      offset+=chunk.byteLength
      const outputId=++this.#next
      this.#receipts.set(outputId,next)
      try{this.send({type:'native-thread-output',stream,bytes:chunk,outputId})}
      catch(error){this.#receipts.delete(outputId);finish(error instanceof Error?error:Error(String(error)))}
    }
    next()
  }
  acknowledge(outputId:number){
    const next=this.#receipts.get(outputId)
    this.#receipts.delete(outputId)
    next?.()
  }
}
