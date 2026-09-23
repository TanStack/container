/** One trusted initializer per engine instance. Not a project artifact cache.
 * Retained bytes are bounded separately from the unchanged guest heap budget.
 * Consumers receive a temporary copy, never the retained buffer. */
export class TrustedInitializerCache {
  #entry?:{source:string;bytes:Uint8Array}
  #closed=false
  #compiling=false
  constructor(private readonly engine:object,readonly maxBytes=8*1024*1024){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<=0||maxBytes>8*1024*1024)throw new RangeError('Invalid initializer cache limit')
  }
  get retainedBytes(){return this.#entry?.bytes.byteLength??0}
  use<T>(engine:object,source:string,compile:()=>Uint8Array,evaluate:(bytes:Uint8Array)=>T):T{
    if(this.#closed)throw Error('Initializer cache is closed')
    if(engine!==this.engine)throw Error('Initializer belongs to a different engine')
    if(this.#compiling)throw Error('Initializer compilation is already active')
    if(this.#entry&&this.#entry.source!==source)throw Error('Initializer source is already fixed')
    if(!this.#entry){
      if(new TextEncoder().encode(source).byteLength>2*1024*1024)throw new RangeError('Initializer source limit exceeded')
      this.#compiling=true
      try{
        const bytes=compile()
        if(this.#closed)throw Error('Initializer cache is closed')
        if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>this.maxBytes)throw new RangeError('Compiled initializer limit exceeded')
        this.#entry={source,bytes:bytes.slice()}
      }finally{this.#compiling=false}
    }
    return evaluate(this.#entry.bytes.slice())
  }
  close(){this.#closed=true;this.#entry=undefined}
}
