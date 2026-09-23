// Host completions may arrive during an Asyncify suspension. They must not
// allocate handles, resolve guest promises or enter guest code until run ends.
export type CompletionSource='other'|'host-operation'|'filesystem'|'process-event'|'worker-message'|'routed-port'|'timer'|'watcher'
export class EngineAccess {
  #busy=false
  #closed=false
  #draining=false
  #pending:Array<{completion:()=>void;workerEndpoint?:number;sequence:number;source:CompletionSource}>=[]
  #sequence=0
  #timing?:{times:number[];enqueued:number;drained:number;maxPending:number;totalWaitMs:number;maxWaitMs:number}
  constructor(readonly maxPending=512,private readonly clock?:()=>number){
    if(!Number.isSafeInteger(maxPending)||maxPending<1)throw Error('Invalid engine completion limit')
    if(clock)this.#timing={times:[],enqueued:0,drained:0,maxPending:0,totalWaitMs:0,maxWaitMs:0}
  }
  snapshot(){
    const timing=this.#timing
    if(!timing)return undefined
    const {times,...totals}=timing
    return {...totals,oldestPendingMs:times.length?Math.max(0,this.clock!()-times[0]!):0}
  }
  get busy(){return this.#busy}
  get pending(){return this.#pending.length}
  get nextWorkerEndpoint(){return this.#pending[0]?.workerEndpoint}
  get boundary(){return this.#sequence}
  pendingSources(){
    const counts:Partial<Record<CompletionSource,number>>={}
    for(const entry of this.#pending)counts[entry.source]=(counts[entry.source]??0)+1
    return counts
  }
  pendingSnapshot(boundary=this.boundary){
    const grouped=new Map<number,{endpoint:number;pending:number;throughBoundary:number}>()
    let throughBoundary=0,nonWorker=0
    for(const entry of this.#pending){
      if(entry.sequence<=boundary)throughBoundary++
      if(entry.workerEndpoint===undefined){nonWorker++;continue}
      let group=grouped.get(entry.workerEndpoint)
      if(!group){group={endpoint:entry.workerEndpoint,pending:0,throughBoundary:0};grouped.set(entry.workerEndpoint,group)}
      group.pending++;if(entry.sequence<=boundary)group.throughBoundary++
    }
    const workers=[...grouped.values()].slice(0,32)
    return {total:this.#pending.length,throughBoundary,nonWorker,workerEndpoints:grouped.size,workers,truncated:grouped.size-workers.length}
  }
  pendingThrough(boundary:number){return this.#pending.filter(entry=>entry.sequence<=boundary).length}
  async run<T>(operation:()=>T|Promise<T>):Promise<T>{
    if(this.#closed)throw Error('Engine access closed')
    if(this.#busy||this.#draining)throw Error('Engine already executing')
    this.#busy=true
    try{return await operation()}finally{this.#busy=false}
  }
  enqueue(completion:()=>void,workerEndpoint?:number,source:CompletionSource='other'){
    if(this.#closed)throw Error('Engine access closed')
    if(this.#pending.length>=this.maxPending)throw Object.assign(Error('Engine completion queue full'),{code:'ERR_RESOURCE_LIMIT'})
    this.#pending.push({completion,workerEndpoint,sequence:++this.#sequence,source})
    if(this.#timing){this.#timing.times.push(this.clock!());this.#timing.enqueued++;this.#timing.maxPending=Math.max(this.#timing.maxPending,this.#pending.length)}
  }
  drain(limit=this.#pending.length,workerEndpoint?:number){
    if(this.#closed)throw Error('Engine access closed')
    if(this.#busy||this.#draining)throw Error('Cannot drain while engine is executing')
    // New arrivals wait for the next drain, so callbacks cannot spin forever.
    if(!Number.isSafeInteger(limit)||limit<0)throw Error('Invalid completion drain limit')
    const available=workerEndpoint===undefined?this.#pending.length:this.#pending.filter(entry=>entry.workerEndpoint===workerEndpoint).length
    const count=Math.min(limit,available)
    let drained=0
    this.#draining=true
    try{for(let index=0;index<count;index++){
      const position=workerEndpoint===undefined?0:this.#pending.findIndex(entry=>entry.workerEndpoint===workerEndpoint)
      if(position<0)break
      const {completion}=this.#pending.splice(position,1)[0]!
      if(this.#timing){const wait=Math.max(0,this.clock!()-this.#timing.times.splice(position,1)[0]!);this.#timing.drained++;this.#timing.totalWaitMs+=wait;this.#timing.maxWaitMs=Math.max(this.#timing.maxWaitMs,wait)}
      drained++;completion()
    }}finally{this.#draining=false}
    return drained
  }
  close(){
    if(this.#busy||this.#draining)throw Error('Cannot close while engine is executing')
    this.#closed=true;this.#pending=[]
    if(this.#timing)this.#timing.times=[]
  }
}
