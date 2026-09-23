import {abortableWait} from './abortable-wait'

interface Entry<T>{controller:AbortController;pending:Promise<T>;users:number;settled:boolean}

// Internal cache for the fixed set of trusted engine asset URLs.
export class SharedAsset<T>{
  #entries=new Map<string,Entry<T>>()
  constructor(readonly load:(key:string,signal:AbortSignal)=>Promise<T>){}
  async acquire(key:string,signal:AbortSignal):Promise<T>{
    signal.throwIfAborted()
    let entry=this.#entries.get(key)
    if(!entry){
      const created:Entry<T>={controller:new AbortController(),pending:undefined!,users:0,settled:false}
      created.pending=Promise.resolve().then(()=>{
        created.controller.signal.throwIfAborted()
        return this.load(key,created.controller.signal)
      }).then(value=>{
        created.controller.signal.throwIfAborted()
        created.settled=true
        return value
      }).catch(error=>{
        created.settled=true
        if(this.#entries.get(key)===created)this.#entries.delete(key)
        throw error
      })
      this.#entries.set(key,created);entry=created
    }
    entry.users++
    try{return await abortableWait(entry.pending,signal)}
    finally{
      entry.users--
      if(!entry.users&&!entry.settled){
        if(this.#entries.get(key)===entry)this.#entries.delete(key)
        entry.controller.abort(Error('Engine asset has no remaining consumers'))
      }
    }
  }
}
