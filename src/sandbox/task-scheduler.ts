// Host-only task turns. Promise.resolve would not yield to editor messages;
// repeated setTimeout(0) adds timer delays to every bounded guest job batch.
export interface TaskSchedulerSample {
  phase:'post'|'dispatch'
  postSequence:number
  dispatchSequence?:number
  taskId:number
  kind:'checkpoint'|'wait'
  postedAt:number
  dispatchAt?:number
}
let postSequence=0,dispatchSequence=0
export class TaskScheduler {
  #channel=new MessageChannel()
  #next=0
  #closed=false
  #checkpoints=new Map<number,()=>void>()
  #samples=new Map<number,TaskSchedulerSample>()
  #pending?:{id:number;resolve:()=>void;posted:boolean;timer?:ReturnType<typeof setTimeout>}
  constructor(private readonly observer?:(sample:TaskSchedulerSample)=>void,private readonly clock:()=>number=()=>performance.now()){
    this.#channel.port1.onmessage=event=>{
      this.#dispatch(event.data)
      const checkpoint=this.#checkpoints.get(event.data)
      if(checkpoint){this.#checkpoints.delete(event.data);checkpoint();return}
      if(this.#pending?.id===event.data)this.#finish()
    }
  }
  #observe(sample:TaskSchedulerSample){try{this.observer?.({...sample})}catch{/* Diagnostics must not affect scheduling. */}}
  #post(taskId:number,kind:TaskSchedulerSample['kind']){
    if(this.observer)try{
      const sample:TaskSchedulerSample={phase:'post',postSequence:++postSequence,taskId,kind,postedAt:this.clock()}
      this.#samples.set(taskId,sample);this.#observe(sample)
    }catch{/* Diagnostic clocks must not prevent the task from being posted. */}
    this.#channel.port2.postMessage(taskId)
  }
  #dispatch(taskId:number){
    const sample=this.#samples.get(taskId)
    if(!sample)return
    this.#samples.delete(taskId)
    try{this.#observe({...sample,phase:'dispatch',dispatchSequence:++dispatchSequence,dispatchAt:this.clock()})}catch{/* Diagnostic clocks must not prevent resumption. */}
  }
  // Unlike an I/O wait, this must not wake from a host promise completion. The
  // posted task proves the current host microtask queue has fully drained.
  checkpoint():Promise<void>{
    if(this.#closed)return Promise.reject(new Error('Scheduler closed'))
    return new Promise(resolve=>{const id=++this.#next;this.#checkpoints.set(id,resolve);this.#post(id,'checkpoint')})
  }
  wait(ready:boolean,timeoutMs?:number):Promise<void>{
    if(this.#closed)return Promise.reject(new Error('Scheduler closed'))
    if(this.#pending)return Promise.reject(new Error('Scheduler already waiting'))
    return new Promise(resolve=>{
      const id=++this.#next,pending:{id:number;resolve:()=>void;posted:boolean;timer?:ReturnType<typeof setTimeout>}={id,resolve,posted:false}
      this.#pending=pending
      if(ready)this.wake()
      else if(timeoutMs!==undefined)pending.timer=setTimeout(()=>{if(this.#pending?.id===id)this.wake()},timeoutMs)
    })
  }
  wake(){
    const pending=this.#pending
    if(!pending||pending.posted)return
    // I/O may settle in a host microtask. Resume through a task even then,
    // so a chain of completions cannot starve worker messages and timers.
    pending.posted=true
    this.#post(pending.id,'wait')
  }
  #finish(){
    const pending=this.#pending
    if(!pending)return
    this.#pending=undefined
    if(pending.timer!==undefined)clearTimeout(pending.timer)
    pending.resolve()
  }
  close(){
    if(this.#closed)return
    this.#closed=true;this.#finish()
    for(const resolve of this.#checkpoints.values())resolve()
    this.#checkpoints.clear()
    this.#samples.clear()
    this.#channel.port1.close();this.#channel.port2.close()
  }
}
