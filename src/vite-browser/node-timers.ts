type TimerCallback = (...args: unknown[]) => void
import '../native/disposal-symbols.mjs'
import {NativeAsyncLocalStorage} from '../native/async-context'

type Activity={handles:Set<object>;waiters:Set<()=>void>;labels?:WeakMap<object,string>;recent?:string[]}
let commandActivity:Activity|undefined
// Keep the idle checkpoint outside the guest timer handles it is measuring.
const scheduleActivityCheckpoint=globalThis.setTimeout.bind(globalThis)
const commandHandleSymbol=Symbol.for('web-container:command-handle')
const commandHandleGlobal=globalThis as unknown as Record<symbol,((handle:object,active:boolean)=>void)|undefined>
function updateActivity(activity:Activity|undefined,handle:object,active:boolean){
  if(!activity)return
  if(active)activity.handles.add(handle)
  else activity.handles.delete(handle)
  if(activity.recent){
    activity.recent.push(`${Math.round(performance.now())} ${active?'+':'-'} ${activity.handles.size} ${activity.labels?.get(handle)??'unknown'}`)
    if(activity.recent.length>300)activity.recent.shift()
  }
  if(!activity.handles.size){for(const waiter of activity.waiters)waiter();activity.waiters.clear()}
}

/** Track ref'ed timer handles created by a project command after bootstrap. */
export function beginNodeCommandTimerActivity(trace=false){
  if(commandActivity)throw Error('Command timer activity is already running')
  const activity:Activity={handles:new Set(),waiters:new Set(),
    ...(trace?{labels:new WeakMap<object,string>(),recent:[] as string[]}:{})}
  commandActivity=activity
  const updateHandle=(handle:object,active:boolean)=>updateActivity(activity,handle,active)
  commandHandleGlobal[commandHandleSymbol]=updateHandle
  return {
    waitForIdle:async()=>{
      for(;;){
        if(activity.handles.size)await new Promise<void>(resolve=>activity.waiters.add(resolve))
        // Microtasks from the last callback may create new referenced work.
        // Observe the next task boundary before declaring the process idle.
        await new Promise<void>(resolve=>scheduleActivityCheckpoint(resolve,0))
        if(!activity.handles.size)return
      }
    },
    track:(handle:object,active:boolean,label='module fetch')=>{
      if(active)activity.labels?.set(handle,label)
      if(active)updateActivity(activity,handle,true)
      else setTimeout(()=>updateActivity(activity,handle,false),0)
    },
    trace:()=>activity.recent?.slice()??[],
    stop:()=>{if(commandActivity===activity)commandActivity=undefined;
      if(commandHandleGlobal[commandHandleSymbol]===updateHandle)delete commandHandleGlobal[commandHandleSymbol]
      activity.handles.clear();
      for(const waiter of activity.waiters)waiter();activity.waiters.clear()},
  }
}

/** Keep a command worker alive while browser-backed async I/O is pending. */
export function trackNodeCommandPromise<T>(promise:Promise<T>):Promise<T>{
  const activity=commandActivity
  if(!activity)return promise
  const handle={}
  activity.labels?.set(handle,new Error().stack?.split('\n').slice(2,5).join(' | ')??'promise')
  updateActivity(activity,handle,true)
  return promise.finally(()=>{setTimeout(()=>updateActivity(activity,handle,false),0)})
}

/** Keep an event-driven I/O handle alive until it emits its terminal event. */
export function keepNodeCommandAlive():()=>void{
  const activity=commandActivity,handle={}
  activity?.labels?.set(handle,new Error().stack?.split('\n').slice(2,5).join(' | ')??'I/O handle')
  updateActivity(activity,handle,true)
  let released=false
  return ()=>{if(released)return;released=true;updateActivity(activity,handle,false)}
}

export function installNodeTimerHandles(): void {
  const browserSetTimeout = globalThis.setTimeout.bind(globalThis)
  const browserClearTimeout = globalThis.clearTimeout.bind(globalThis)
  const browserSetInterval = globalThis.setInterval.bind(globalThis)
  const browserClearInterval = globalThis.clearInterval.bind(globalThis)

  class TimerHandle {
    private id: ReturnType<typeof browserSetTimeout>
    private active = true
    private referenced = true
    private readonly activity=commandActivity

    constructor(
      private readonly repeating: boolean,
      private readonly callback: TimerCallback,
      private readonly delay: number,
      private readonly args: unknown[],
    ) {
      this.activity?.labels?.set(this,`timer ${delay}ms`)
      updateActivity(this.activity,this,true)
      this.id = this.schedule()
    }

    private schedule(): ReturnType<typeof browserSetTimeout> {
      const fire = () => {
        try{this.callback(...this.args)}
        finally{if (!this.repeating){this.active = false;updateActivity(this.activity,this,false)}}
      }
      return this.repeating
        ? browserSetInterval(fire, this.delay)
        : browserSetTimeout(fire, this.delay)
    }

    clear(): void {
      if (!this.active) return
      this.active = false
      updateActivity(this.activity,this,false)
      if (this.repeating) browserClearInterval(this.id)
      else browserClearTimeout(this.id)
    }

    ref(): this { this.referenced = true; if(this.active)updateActivity(this.activity,this,true);return this }
    unref(): this { this.referenced = false; updateActivity(this.activity,this,false);return this }
    hasRef(): boolean { return this.referenced }

    refresh(): this {
      this.clear()
      this.active = true
      if(this.referenced)updateActivity(this.activity,this,true)
      this.id = this.schedule()
      return this
    }
  }

  globalThis.setTimeout = ((callback: TimerCallback, delay = 0, ...args: unknown[]) =>
    new TimerHandle(false, callback, delay, args)) as unknown as typeof globalThis.setTimeout
  globalThis.setInterval = ((callback: TimerCallback, delay = 0, ...args: unknown[]) =>
    new TimerHandle(true, callback, delay, args)) as unknown as typeof globalThis.setInterval
  globalThis.clearTimeout = ((handle?: TimerHandle | number) => {
    if (handle instanceof TimerHandle) handle.clear()
    else browserClearTimeout(handle)
  }) as typeof globalThis.clearTimeout
  globalThis.clearInterval = ((handle?: TimerHandle | number) => {
    if (handle instanceof TimerHandle) handle.clear()
    else browserClearInterval(handle)
  }) as typeof globalThis.clearInterval

  class ImmediateHandle {
    private readonly channel=new MessageChannel()
    private active=true
    private referenced=true
    private readonly activity=commandActivity

    constructor(callback:TimerCallback,args:unknown[]){
      this.activity?.labels?.set(this,'immediate')
      updateActivity(this.activity,this,true)
      const invoke=NativeAsyncLocalStorage.bind(callback)
      this.channel.port1.onmessage=()=>{
        if(!this.active)return
        try{invoke(...args)}finally{this.clear()}
      }
      this.channel.port2.postMessage(null)
    }

    clear(){
      if(!this.active)return
      this.active=false
      updateActivity(this.activity,this,false)
      this.channel.port1.close()
      this.channel.port2.close()
    }
    ref():this{this.referenced=true;if(this.active)updateActivity(this.activity,this,true);return this}
    unref():this{this.referenced=false;updateActivity(this.activity,this,false);return this}
    hasRef():boolean{return this.referenced}
    [Symbol.dispose](){this.clear()}
  }

  globalThis.setImmediate=((callback:TimerCallback,...args:unknown[])=>{
    if(typeof callback!=='function')throw new TypeError('Expected callback')
    return new ImmediateHandle(callback,args)
  }) as unknown as typeof globalThis.setImmediate
  globalThis.clearImmediate=((handle?:ImmediateHandle)=>handle?.clear()) as typeof globalThis.clearImmediate
}
