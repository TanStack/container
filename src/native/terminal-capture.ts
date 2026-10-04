/** Bound retained terminal output across both streams without limiting live observers. */
export class NativeTerminalCapture {
  #bytes=0
  #out=new TextDecoder()
  #err=new TextDecoder()
  #stdout:string[]=[]
  #stderr:string[]=[]
  truncated=false
  constructor(readonly maxBytes=1024*1024){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024)throw Error('maxTerminalOutputBytes must be between 1 and 16777216')
  }
  write(text:string,stream:'stdout'|'stderr'){
    const bytes=new TextEncoder().encode(text)
    const retained=bytes.subarray(0,Math.max(0,this.maxBytes-this.#bytes))
    this.#bytes+=retained.length
    if(retained.length<bytes.length)this.truncated=true
    if(retained.length===0)return
    const decoder=stream==='stdout'?this.#out:this.#err
    ;(stream==='stdout'?this.#stdout:this.#stderr).push(decoder.decode(retained,{stream:true}))
  }
  finish(){
    // Each input string encodes complete characters. Only the byte-budget cut
    // can leave an incomplete character, which must not become a larger U+FFFD.
    return {stdout:this.#stdout.join(''),stderr:this.#stderr.join(''),truncated:this.truncated}
  }
}
