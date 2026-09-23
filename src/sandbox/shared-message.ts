import type {QuickJSContext,QuickJSHandle} from 'quickjs-emscripten-core'
import type {MessageResource} from './process-message-queue'

export interface SharedBufferLease {readonly alive:boolean;adopt(context:QuickJSContext):ReturnType<QuickJSContext['evalCode']>;dispose():void}
export type SharedContext=QuickJSContext&{retainSharedBuffer(value:QuickJSHandle):SharedBufferLease;retainSharedWasmMemory(value:QuickJSHandle):SharedBufferLease}
function releaseLeases(leases:Iterable<SharedBufferLease>){
  let error:unknown
  for(const lease of leases)try{lease.dispose()}catch(cause){error??=cause}
  if(error!==undefined)throw error
}

/** Host-owned message references. IDs are scoped to this envelope, never native pointers. */
export class SharedMessage implements MessageResource {
  constructor(private leases:Map<number,SharedBufferLease>){}
  adopt(id:number,context:QuickJSContext){
    const lease=this.leases.get(id)
    if(!lease)throw Error('Shared buffer is unavailable in this delivery')
    const result=lease.adopt(context)
    if(!result.error)this.leases.delete(id)
    return result
  }
  dispose(){const leases=this.leases;this.leases=new Map();releaseLeases(leases.values())}
}

export class SharedMessageSender {
  #next=0
  #pending=new Map<number,SharedBufferLease>()
  retain(context:SharedContext,value:QuickJSHandle){
    return this.#retain(()=>context.retainSharedBuffer(value))
  }
  retainMemory(context:SharedContext,value:QuickJSHandle){
    return this.#retain(()=>context.retainSharedWasmMemory(value))
  }
  #retain(create:()=>SharedBufferLease){
    if(this.#pending.size>=256||this.#next>=0xffffffff)throw Error('Shared message reference limit reached')
    const lease=create(),id=++this.#next
    this.#pending.set(id,lease);return id
  }
  #entries(ids:unknown){
    if(!Array.isArray(ids)||ids.length>256||new Set(ids).size!==ids.length)throw Error('Invalid shared message references')
    return ids.map(id=>{
      const lease=this.#pending.get(id)
      if(!Number.isInteger(id)||!lease)throw Error('Shared message reference is unavailable')
      return [id,lease] as const
    })
  }
  release(ids:unknown){for(const [id,lease] of this.#entries(ids)){this.#pending.delete(id);lease.dispose()}}
  send<T>(ids:unknown,accept:(message:SharedMessage)=>T):T{
    const entries=this.#entries(ids),message=new SharedMessage(new Map(entries))
    const result=accept(message)
    for(const [id] of entries)this.#pending.delete(id)
    return result
  }
  dispose(){const leases=this.#pending;this.#pending=new Map();releaseLeases(leases.values())}
}

export function sharedDelivery(resources:readonly MessageResource[]){
  const message=resources.find((resource):resource is SharedMessage=>resource instanceof SharedMessage)
  if(!message)throw Error('Delivery has no shared buffers')
  return message
}
