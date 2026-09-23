// Node MessagePort::OnMessage drains the active port until empty, including
// arrivals during callbacks, bounded by max(initial backlog,1000) callbacks.
// https://github.com/nodejs/node/blob/v24.x/src/node_messaging.cc#L755-L833
// Never wait for a future reply after observing an empty active endpoint.
export class WorkerPoll {
  #observed=new Map<number,number>()
  #targets=new Map<number,number>()
  #eligible=new Set<number>()
  #active:number|undefined
  constructor(private readonly snapshot:(endpoint:number)=>{token:number;closed:boolean},private readonly batchFloor=1000){
    if(!Number.isSafeInteger(batchFloor)||batchFloor<1||batchFloor>1000)throw new RangeError('Invalid worker poll batch floor')
  }
  observe(endpoint:number){if(!this.#observed.has(endpoint))this.#observed.set(endpoint,0)}
  settled(endpoint:number,token:number){this.#observed.set(endpoint,token)}
  diagnosticSnapshot(endpoints:readonly number[]){
    return endpoints.slice(0,32).map(endpoint=>({endpoint,observed:this.#observed.has(endpoint),settled:this.#observed.get(endpoint),limit:this.#targets.get(endpoint),eligible:this.#eligible.has(endpoint),active:this.#active===endpoint}))
  }
  begin(){
    this.#active=undefined
    this.#targets.clear()
    this.#eligible=new Set(this.#observed.keys())
    this.#admitReady()
  }
  #admitReady(){
    for(const endpoint of this.#eligible){
      const settled=this.#observed.get(endpoint)??0
      const value=this.#read(endpoint)
      if(!value||value.closed){this.#eligible.delete(endpoint);continue}
      if(value.token>settled){
        this.#eligible.delete(endpoint)
        this.#targets.set(endpoint,settled+Math.max(this.batchFloor,value.token-settled))
      }
    }
  }
  get pending(){
    // Admit each observed port at most once per poll turn, including a port
    // made ready by another port's callback. Empty ports never keep us waiting.
    this.#admitReady()
    for(const [endpoint,limit] of this.#targets){
      const value=this.#read(endpoint)
      const settled=this.#observed.get(endpoint)??0
      if(!value||value.closed||settled>=limit||value.token<=settled)this.#targets.delete(endpoint)
    }
    return this.#targets.size>0
  }
  get active():number|undefined{
    this.pending
    if(this.#active!==undefined&&!this.#targets.has(this.#active))this.#active=undefined
    return this.#active
  }
  activate(endpoint:number|undefined){
    if(this.active===undefined&&endpoint!==undefined&&this.#targets.has(endpoint))this.#active=endpoint
  }
  #read(endpoint:number){
    try{return this.snapshot(endpoint)}catch{this.#observed.delete(endpoint);return undefined}
  }
}
