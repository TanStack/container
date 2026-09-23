import type {MessageResource} from './process-message-queue'

/** Independent host-byte budget, never inferred from the control-message quota. */
export class ModuleMessageBudget {
  #bytes=0
  constructor(readonly maxBytes:number){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new RangeError('Invalid module resource budget')
  }
  get bytes(){return this.#bytes}
  retain(input:Uint8Array){
    if(!(input instanceof Uint8Array))throw new TypeError('Expected module bytes')
    if(input.byteLength>this.maxBytes-this.#bytes)throw new RangeError('Module resource budget exceeded')
    const bytes=input.slice();this.#bytes+=bytes.byteLength
    let alive=true
    return {
      copy:()=>{if(!alive)throw Error('Module resource is disposed');return bytes.slice()},
      dispose:()=>{if(alive){alive=false;this.#bytes-=bytes.byteLength}},
    }
  }
}
type ModuleLease=ReturnType<ModuleMessageBudget['retain']>

/** IDs are meaningful only inside this acknowledged message envelope. */
export class ModuleMessage implements MessageResource {
  constructor(private leases:Map<number,ModuleLease>){}
  adopt(id:number){
    const lease=this.leases.get(id)
    if(!lease)throw Error('Module resource is unavailable in this delivery')
    // Compilation receives an independent copy. The envelope keeps its charge
    // until acknowledgment or disposal, including failed destination compilation.
    return lease.copy()
  }
  dispose(){const leases=this.leases;this.leases=new Map();for(const lease of leases.values())lease.dispose()}
}

export class ModuleMessageSender {
  #next=0
  #pending=new Map<number,ModuleLease>()
  #closed=false
  constructor(readonly budget:ModuleMessageBudget){}
  retain(bytes:Uint8Array){
    if(this.#closed)throw Error('Module sender is disposed')
    if(this.#pending.size>=256||this.#next>=0xffffffff)throw new RangeError('Module reference limit reached')
    const lease=this.budget.retain(bytes),id=++this.#next
    this.#pending.set(id,lease);return id
  }
  #entries(ids:unknown){
    if(!Array.isArray(ids)||ids.length>256||new Set(ids).size!==ids.length)throw Error('Invalid module message references')
    return ids.map(id=>{
      const lease=this.#pending.get(id)
      if(!Number.isInteger(id)||!lease)throw Error('Module message reference is unavailable')
      return [id,lease] as const
    })
  }
  release(ids:unknown){for(const [id,lease] of this.#entries(ids)){this.#pending.delete(id);lease.dispose()}}
  send<T>(ids:unknown,accept:(message:ModuleMessage)=>T):T{
    const entries=this.#entries(ids),message=new ModuleMessage(new Map(entries))
    // On rejection, pending ownership stays with the caller for rollback.
    const result=accept(message)
    for(const [id] of entries)this.#pending.delete(id)
    return result
  }
  dispose(){this.#closed=true;const leases=this.#pending;this.#pending=new Map();for(const lease of leases.values())lease.dispose()}
}

export function moduleDelivery(resources:readonly MessageResource[]){
  const message=resources.find((resource):resource is ModuleMessage=>resource instanceof ModuleMessage)
  if(!message)throw Error('Delivery has no module resources')
  return message
}
