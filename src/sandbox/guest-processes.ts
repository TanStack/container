import type {KernelExecutionResult,KernelOptions} from './kernel'
import type {ProcessLifetime} from './execution-budget'
import {ProcessMessageQueue,type MessageResource} from './process-message-queue'
import {PortRouter} from './port-router'
import {VirtualTerminal,terminalOptions,type TerminalOptions} from './terminal'

const failure=(code:string,message=code)=>Object.assign(Error(message),{code})
const processSignal=(value:string|number):string|0=>{
  if(value===0)return 0
  if(typeof value==='string'){
    const signal=value.toUpperCase()
    if(signal==='SIGTERM'||signal==='SIGKILL'||signal==='SIGINT')return signal
  }else if(value===15)return 'SIGTERM'
  else if(value===9)return 'SIGKILL'
  else if(value===2)return 'SIGINT'
  throw failure('ERR_UNKNOWN_SIGNAL','Unknown signal: '+String(value))
}
export type ProcessEvent=
  |{type:'stdout'|'stderr';bytes:Uint8Array}
  |{type:'online'}
  |{type:'error';error:{name:string;message:string;stack?:string;code?:string}}
  |{type:'exit';code:number|null;signal:string|null}
export type StdioMode='pipe'|'ignore'|'inherit'
export function processStdio(value:unknown):[StdioMode,StdioMode,StdioMode]{
  const values=value===undefined?[]:typeof value==='string'?[value,value,value]:value
  if(!Array.isArray(values)||values.length>3)throw failure('ERR_UNSUPPORTED_OPERATION','Unsupported process stdio')
  return [0,1,2].map(index=>{
    const mode=values[index]??'pipe'
    if(mode===index)return 'inherit'
    if(mode!=='pipe'&&mode!=='ignore'&&mode!=='inherit')throw failure('ERR_UNSUPPORTED_OPERATION','Unsupported process stdio entry')
    return mode
  }) as [StdioMode,StdioMode,StdioMode]
}
export interface SpawnOptions extends Omit<KernelOptions,'onOutput'> {env?:Record<string,string>;cwd?:string;
  /** Owner-only virtual terminal. Omit to retain ordinary pipe semantics. */
  terminal?:TerminalOptions;
  stdio?:StdioMode|Array<StdioMode|number|null|undefined>;
  /** Host opt-in: wait indefinitely for I/O, with timeoutMs bounding each runnable turn. Children cannot raise this authority. */
  lifetime?:ProcessLifetime}
interface ProcessInputBase {argv:string[];execArgv?:string[];ipc?:boolean;ipcMode?:'json'|'advanced';worker?:{threadId:number;data:string};options:SpawnOptions}
export type ProcessInput=ProcessInputBase&(
  |{kind?:'javascript';code:string;entry?:string;loadModules?:boolean;evalCommonJS?:boolean}
  |{kind:'shell';script:string;code?:never;entry?:never;loadModules?:never;evalCommonJS?:never}
)

export class InputPipe {
  #queue:Uint8Array[]=[]
  #bytes=0
  #ended=false
  #readers=new Map<number,{length:number;resolve:(value:Uint8Array|null)=>void;reject:(error:Error)=>void}>()
  #writer?:{bytes:Uint8Array;resolve:()=>void;reject:(error:Error)=>void}
  write(bytes:Uint8Array):Promise<void>{
    if(this.#ended)throw failure('EPIPE')
    if(!(bytes instanceof Uint8Array)||bytes.length>65536)throw failure('ERR_RESOURCE_LIMIT','Stdin writes are limited to 64 KiB')
    if(this.#writer)throw failure('EBUSY','A stdin write is already pending')
    if(!bytes.length)return Promise.resolve()
    return new Promise((resolve,reject)=>{this.#writer={bytes:bytes.slice(),resolve,reject};this.#flush()})
  }
  #flush(){
    const drain=()=>{while(this.#queue.length&&this.#readers.size){
      const [owner,reader]=this.#readers.entries().next().value!
      this.#readers.delete(owner);reader.resolve(this.#take(reader.length))
    }}
    drain()
    const writer=this.#writer
    if(!writer)return
    if(this.#bytes+writer.bytes.length>65536||this.#queue.length>=256)return
    this.#queue.push(writer.bytes);this.#bytes+=writer.bytes.length
    this.#writer=undefined;writer.resolve();drain()
  }
  #take(length:number){
    const bytes=this.#queue[0],count=Math.min(length,bytes.length)
    const result=bytes.slice(0,count)
    if(count===bytes.length)this.#queue.shift();else this.#queue[0]=bytes.subarray(count)
    this.#bytes-=count;return result
  }
  read(owner=0,length=65536):Promise<Uint8Array|null>{
    if(!Number.isSafeInteger(length)||length<0||length>65536)throw failure('EINVAL','Invalid stdin read length')
    if(length===0)return Promise.resolve(new Uint8Array())
    if(this.#readers.has(owner))throw failure('EBUSY','A stdin read is already pending')
    if(this.#readers.size>=8)throw failure('ERR_RESOURCE_LIMIT','Too many inherited stdin readers')
    if(this.#queue.length){const bytes=this.#take(length);this.#flush();return Promise.resolve(bytes)}
    if(this.#ended)return Promise.resolve(null)
    return new Promise((resolve,reject)=>this.#readers.set(owner,{length,resolve,reject}))
  }
  cancelRead(owner:number){this.#readers.get(owner)?.resolve(null);this.#readers.delete(owner)}
  end(){if(this.#writer)throw failure('EBUSY','Wait for pending stdin writes');this.#ended=true;for(const reader of this.#readers.values())reader.resolve(null);this.#readers.clear()}
  close(){this.#ended=true;this.#queue=[];this.#bytes=0;for(const reader of this.#readers.values())reader.resolve(null);this.#readers.clear();this.#writer?.reject(failure('EPIPE'));this.#writer=undefined}
}

export interface ManagedProcess {
  sharedStartup?:MessageResource
  moduleStartup?:MessageResource
  terminal?:VirtualTerminal
  ipcRef?:boolean
  ipc?:{toParent:ProcessMessageQueue;toChild:ProcessMessageQueue}
  workerRef?:boolean
  workerError?:{name:string;message:string;stack?:string;code?:string}
  workerChannel?:{toParent:ProcessMessageQueue;toChild:ProcessMessageQueue}
  pid:number;owner:number;cwd:string;input:ProcessInput;controller:AbortController;stdin:InputPipe;stdinRef:boolean;ref:boolean;running:boolean;
  signal:string|null;events:ProcessEvent[];queuedBytes:number;next?:(event:ProcessEvent|null)=>void;
  result:Promise<KernelExecutionResult>;wake?:()=>void;capture:boolean;output?:(level:string,text:string)=>void;
  stdio:[StdioMode,StdioMode,StdioMode];ownsStdin:boolean;receiveOutput?:(event:Extract<ProcessEvent,{bytes:Uint8Array}>)=>void;
  pendingOutput?:Array<{event:Extract<ProcessEvent,{bytes:Uint8Array}>;resolve:()=>void;reject:(error:Error)=>void}>;
}
export class GuestProcesses {
  readonly ports=new PortRouter()
  #next=1
  #records=new Map<number,ManagedProcess>()
  constructor(readonly run:(record:ManagedProcess)=>Promise<KernelExecutionResult>){}
  get active(){return [...this.#records.values()].filter(record=>record.running)}
  get size(){return this.#records.size}
  get(owner:number,pid:number){const record=this.#records.get(pid);if(!record||record.owner!==owner)throw failure('ESRCH','Process is unavailable to this owner');return record}
  start(owner:number,input:ProcessInput,output?:ManagedProcess['output'],capture=true){
    const active=this.active
    const reservedBytes=active.reduce((total,p)=>total+(p.input.options.maxBytes??16*1024*1024),0),requestedBytes=input.options.maxBytes??16*1024*1024
    const accounting=`active=${active.length}, retained=${this.#records.size}, reservedBytes=${reservedBytes}, requestedBytes=${requestedBytes}`
    if(active.length>=8||this.#records.size>=64)throw failure('EAGAIN',`Guest process limit exceeded (${accounting}, activeLimit=8, retainedLimit=64)`)
    if(reservedBytes+requestedBytes>512*1024*1024)throw failure('ERR_RESOURCE_LIMIT',`Aggregate process memory reservations exceed 512 MiB (${accounting}, limitBytes=${512*1024*1024})`)
    const stdio=processStdio(input.options.stdio),parent=this.#records.get(owner)
    const terminal=terminalOptions(input.options.terminal)
    if(terminal&&(owner!==0||input.kind==='shell'||stdio.some(mode=>mode!=='pipe')))throw failure('ERR_UNSUPPORTED_OPERATION','Virtual terminals require an owner-spawned JavaScript process with piped stdio')
    if(input.ipc&&(!parent||!parent.running))throw failure('ESRCH','IPC requires a live parent process')
    if(input.worker&&(!parent||!parent.running))throw failure('ESRCH','Worker requires a live parent process')
    if(stdio.includes('inherit')&&(!parent||!parent.running))throw failure('ESRCH','Cannot inherit stdio from an unavailable parent')
    const stdin=stdio[0]==='inherit'?parent!.stdin:new InputPipe()
    if(stdio[0]==='ignore')stdin.end()
    const record:ManagedProcess={pid:this.#next++,owner,cwd:input.options.cwd??'/',input,controller:new AbortController(),stdin,stdio,ownsStdin:stdio[0]!=='inherit',stdinRef:false,ref:true,running:true,signal:null,events:[],queuedBytes:0,result:undefined!,output,capture}
    if(terminal)record.terminal=new VirtualTerminal(terminal,bytes=>record.stdin.write(bytes),bytes=>this.writeOutput(record,{type:'stdout',bytes}),()=>{this.kill(owner,record.pid,'SIGINT')})
    if(input.worker)input.worker.threadId=record.pid
    this.#records.set(record.pid,record)
    if(input.ipc)record.ipc={toParent:new ProcessMessageQueue(),toChild:new ProcessMessageQueue()}
    if(input.worker)record.workerChannel={toParent:new ProcessMessageQueue(),toChild:new ProcessMessageQueue()}
    record.result=Promise.resolve().then(()=>this.run(record)).catch(error=>{
      const stderr=String(error)
      try{if(!record.signal)this.emit(record,{type:'stderr',bytes:new TextEncoder().encode(stderr)})}catch{/* Preserve the terminal result if the output queue is already full. */}
      return {exitCode:1,stdout:'',stderr,duration:0,wasmHeapBytes:0}
    }).then(result=>{
      record.running=false;record.stdin.cancelRead(record.pid);if(record.ownsStdin)record.stdin.close()
      this.finishWorkerData(record)
      this.ports.release(record.pid)
      record.ipc?.toParent.end();record.ipc?.toChild.close()
      record.workerChannel?.toParent.end();record.workerChannel?.toChild.close()
      this.#rejectOutput(record)
      this.emit(record,{type:'exit',code:record.signal?null:result.exitCode,signal:record.signal})
      const parent=this.#records.get(owner);parent?.wake?.()
      this.releaseChildren(record.pid)
      return result
    })
    return record
  }
  emit(record:ManagedProcess,event:ProcessEvent){
    if(event.type==='stdout'||event.type==='stderr'){
      const mode=record.stdio[event.type==='stdout'?1:2]
      if(mode==='ignore')return
      if(mode==='inherit'){
        const parent=this.#records.get(record.owner)
        if(!parent?.running)throw failure('EPIPE','Inherited output parent is closed')
        if(parent.receiveOutput)parent.receiveOutput(event);else this.emit(parent,event)
        return
      }
    }
    if(!record.capture)return
    if(record.next){const next=record.next;record.next=undefined;next(event);return}
    const bytes=event.type==='stdout'||event.type==='stderr'?event.bytes.length:0
    if(event.type!=='exit'&&(record.events.length>=4096||record.queuedBytes+bytes>1024*1024))throw failure('ERR_RESOURCE_LIMIT','Process output queue exceeded')
    record.events.push(event);record.queuedBytes+=bytes
  }
  writeOutput(record:ManagedProcess,event:Extract<ProcessEvent,{bytes:Uint8Array}>):Promise<void>{
    if(!record.running||record.signal)throw failure('EPIPE','Process output is closed')
    if(event.bytes.length>65536)throw failure('ERR_RESOURCE_LIMIT','Output writes are limited to 64 KiB')
    const mode=record.stdio[event.type==='stdout'?1:2]
    if(mode==='ignore')return Promise.resolve()
    if(mode==='inherit'){
      const parent=this.#records.get(record.owner)
      if(!parent?.running)throw failure('EPIPE','Inherited output parent is closed')
      if(parent.receiveOutput){parent.receiveOutput(event);return Promise.resolve()}
      return this.writeOutput(parent,event)
    }
    const pending=record.pendingOutput??=[]
    if(pending.some(write=>write.event.type===event.type))throw failure('EBUSY','An output write is already pending')
    if(!pending.length&&(record.next||(record.events.length<4096&&record.queuedBytes+event.bytes.length<=1024*1024))){this.emit(record,{...event,bytes:event.bytes.slice()});return Promise.resolve()}
    return new Promise((resolve,reject)=>pending.push({event:{...event,bytes:event.bytes.slice()},resolve,reject}))
  }
  #flushOutput(record:ManagedProcess){
    const pending=record.pendingOutput
    while(pending?.length){
      const write=pending[0]
      if(record.events.length>=4096||record.queuedBytes+write.event.bytes.length>1024*1024)return
      pending.shift();this.emit(record,write.event);write.resolve()
    }
  }
  #rejectOutput(record:ManagedProcess){for(const write of record.pendingOutput??[])write.reject(failure('EPIPE','Process output is closed'));record.pendingOutput=[]}
  writeInput(owner:number,pid:number,bytes:Uint8Array){const record=this.get(owner,pid);if(record.stdio[0]!=='pipe')throw failure('EPIPE','Child stdin is not a pipe');if(!(bytes instanceof Uint8Array)||bytes.length>65536)throw failure('ERR_RESOURCE_LIMIT','Stdin writes are limited to 64 KiB');return record.terminal?record.terminal.write(bytes):record.stdin.write(bytes)}
  #ipcEndpoint(caller:number,pid:number){
    const record=this.#records.get(pid)
    if(!record||caller!==record.owner&&caller!==record.pid)throw failure('ESRCH','IPC channel is unavailable to this process')
    if(!record.ipc)throw failure('ERR_IPC_CHANNEL_CLOSED','Process has no IPC channel')
    return {record,channel:record.ipc,parent:caller===record.owner}
  }
  sendIPC(caller:number,pid:number,bytes:Uint8Array){
    const {record,channel,parent}=this.#ipcEndpoint(caller,pid)
    if(!record.running||record.signal)throw failure('ERR_IPC_CHANNEL_CLOSED','IPC process is closed')
    const writable=(parent?channel.toChild:channel.toParent).send(bytes)
    record.wake?.();this.#records.get(record.owner)?.wake?.()
    return writable
  }
  receiveIPC(caller:number,pid:number){const {channel,parent}=this.#ipcEndpoint(caller,pid);return (parent?channel.toParent:channel.toChild).receive()}
  connectedIPC(caller:number,pid:number){const {channel}=this.#ipcEndpoint(caller,pid);return channel.toParent.connected&&channel.toChild.connected}
  disconnectIPC(caller:number,pid:number){
    const {record,channel}=this.#ipcEndpoint(caller,pid)
    channel.toChild.end();channel.toParent.end()
    record.wake?.();this.#records.get(record.owner)?.wake?.()
  }
  #workerEndpoint(caller:number,pid:number){
    const record=this.#records.get(pid)
    if(!record||caller!==record.owner&&caller!==record.pid)throw failure('ESRCH','Worker channel is unavailable to this process')
    if(!record.workerChannel)throw failure('ERR_WORKER_NOT_RUNNING','Process is not a worker')
    return {record,channel:record.workerChannel,parent:caller===record.owner}
  }
  sendWorker(caller:number,pid:number,bytes:Uint8Array,ports:number[]=[],resources:readonly MessageResource[]=[]){
    const {record,channel,parent}=this.#workerEndpoint(caller,pid)
    if(!record.running||record.signal)throw failure('ERR_WORKER_NOT_RUNNING','Worker is not running')
    this.ports.validate(caller,ports)
    const writable=(parent?channel.toChild:channel.toParent).send(bytes,resources)
    this.ports.move(caller,parent?record.pid:record.owner,ports)
    record.wake?.();this.#records.get(record.owner)?.wake?.()
    return writable
  }
  receiveWorker(caller:number,pid:number){const {channel,parent}=this.#workerEndpoint(caller,pid);return (parent?channel.toParent:channel.toChild).receive()}
  receiveWorkerDelivery(caller:number,pid:number){const {channel,parent}=this.#workerEndpoint(caller,pid);return (parent?channel.toParent:channel.toChild).receiveLease()}
  workerPollSnapshot(caller:number,pid:number){const {channel,parent}=this.#workerEndpoint(caller,pid);return (parent?channel.toParent:channel.toChild).pollSnapshot()}
  acknowledgeWorker(caller:number,pid:number,token:number){const {channel,parent}=this.#workerEndpoint(caller,pid);(parent?channel.toParent:channel.toChild).ackReceive(token)}
  workerResources(caller:number,pid:number,token:number){const {channel,parent}=this.#workerEndpoint(caller,pid);return (parent?channel.toParent:channel.toChild).deliveryResources(token)}
  finishWorkerData(record:ManagedProcess){const resources=[record.sharedStartup,record.moduleStartup];record.sharedStartup=undefined;record.moduleStartup=undefined;for(const resource of resources)resource?.dispose()}
  closeWorker(caller:number,pid:number){
    const {record,channel,parent}=this.#workerEndpoint(caller,pid)
    // Closing a receiving endpoint abandons its deliveries. Accepted outbound
    // messages remain drainable by the peer before EOF.
    ;(parent?channel.toParent:channel.toChild).close()
    ;(parent?channel.toChild:channel.toParent).end()
    record.wake?.();this.#records.get(record.owner)?.wake?.()
  }
  endInput(owner:number,pid:number){const record=this.get(owner,pid);if(record.stdio[0]!=='pipe')throw failure('EPIPE','Child stdin is not a pipe');return record.stdin.end()}
  next(owner:number,pid:number):Promise<ProcessEvent|null>{
    const record=this.get(owner,pid)
    if(record.next)throw failure('EBUSY','A process event read is already pending')
    const event=record.events.shift()
    if(event){if(event.type==='stdout'||event.type==='stderr')record.queuedBytes-=event.bytes.length;this.#flushOutput(record);return Promise.resolve(event)}
    if(!record.running)return Promise.resolve(null)
    return new Promise(resolve=>record.next=resolve)
  }
  kill(owner:number,pid:number,signal:string|number='SIGTERM'){
    const normalized=processSignal(signal)
    const record=this.get(owner,pid)
    if(!record.running)return false
    if(normalized===0)return true
    record.ipc?.toParent.close();record.ipc?.toChild.close()
    record.workerChannel?.toParent.close();record.workerChannel?.toChild.close()
    record.signal=normalized;record.controller.abort(failure('ECANCELED','Process terminated by '+normalized));record.stdin.cancelRead(record.pid);record.wake?.();this.releaseChildren(pid)
    this.#rejectOutput(record)
    return true
  }
  hasChildren(owner:number){return [...this.#records.values()].some(record=>record.owner===owner&&record.ref)}
  #dropMessages(record:ManagedProcess){record.ipc?.toParent.close();record.ipc?.toChild.close();record.workerChannel?.toParent.close();record.workerChannel?.toChild.close()}
  releaseChildren(owner:number){for(const record of [...this.#records.values()])if(record.owner===owner){if(record.running)this.kill(owner,record.pid,'SIGKILL');this.#dropMessages(record);record.next?.(null);record.next=undefined;void record.result.finally(()=>this.#records.delete(record.pid))}}
  forget(owner:number,pid:number){const record=this.get(owner,pid);if(record.running)throw failure('EBUSY','Cannot forget a running process');this.#dropMessages(record);this.#records.delete(pid)}
}
