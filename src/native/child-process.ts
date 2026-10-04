import {EventEmitter} from '../vite-browser/node-events'
import {PassThrough} from 'stream-browserify'
import {Writable} from 'readable-stream'
import process from 'process/browser'
import {resolve} from '../vite-browser/node-path'
import {keepNodeCommandAlive} from '../vite-browser/node-timers'
import {Worker} from './worker-threads'
import {ipcMessage} from './ipc-message'
import {launchConditions,parseNodeInvocation} from './launch-conditions'
import {fileURLToPath} from '../vite-browser/node-url'
import {Buffer} from 'buffer'
import {promisify} from '../vite-browser/node-util'
import {processInputSource} from './shared-input-source'

type StdioMode='pipe'|'ignore'|'inherit'|'ipc'
type ForkOptions={cwd?:string;env?:Record<string,string>;execArgv?:string[];stdio?:StdioMode|Array<StdioMode|null|undefined>;silent?:boolean;serialization?:string;detached?:boolean;execPath?:string;timeout?:number;signal?:AbortSignal;killSignal?:string;evalSource?:string;stdinSource?:boolean}
type SpawnOptions=ForkOptions&{shell?:boolean|string}
const unsupported=(name:string):never=>{throw Object.assign(new Error(`${name} is not supported by browser child processes`),{code:'ERR_UNSUPPORTED_OPERATION'})}
function stdioModes(stdio:ForkOptions['stdio']):StdioMode[]{
  if(stdio===undefined)return ['pipe','pipe','pipe']
  if(stdio==='pipe'||stdio==='ignore'||stdio==='inherit')return [stdio,stdio,stdio]
  if(!Array.isArray(stdio)||stdio.length>3)unsupported('Requested stdio mode')
  return [0,1,2].map(index=>{
    const mode=stdio[index]??'pipe'
    if(mode!=='pipe'&&mode!=='ignore'&&mode!=='inherit')unsupported('Requested stdio mode')
    return mode
  })
}
function validateLifetime(options:ForkOptions){
  if(options.timeout!==undefined&&(!Number.isInteger(options.timeout)||options.timeout<0))throw RangeError('Invalid timeout')
  if(options.killSignal!==undefined&&!['SIGTERM','SIGKILL'].includes(options.killSignal))unsupported(`Signal ${options.killSignal}`)
  if(options.signal!==undefined&&(!options.signal||typeof options.signal.aborted!=='boolean'||
    typeof options.signal.addEventListener!=='function'||typeof options.signal.removeEventListener!=='function'))throw TypeError('Invalid AbortSignal')
}

export class ChildProcess extends EventEmitter{
  readonly pid:number
  readonly stdout:PassThrough|null
  readonly stderr:PassThrough|null
  readonly stdin:Writable|null
  readonly stdio:Array<Writable|PassThrough|null>
  readonly #worker:Worker
  #release:(()=>void)|undefined
  #exited=false
  #outputOpen=0
  #closed=false
  readonly #ipc:boolean
  #disconnectEmitted=false
  readonly #serialization:'json'|'advanced'
  connected=true
  killed=false
  exitCode:number|null=null
  signalCode:string|null=null
  constructor(filename:string,args:string[],options:ForkOptions,ipc=true){
    super()
    this.#ipc=ipc
    const modes=stdioModes(options.stdio)
    const inputSource=modes[0]==='inherit'?processInputSource:undefined
    if(modes[0]==='inherit'&&!inputSource)unsupported('Inherited stdin without a process input source')
    this.stdout=modes[1]==='pipe'?new PassThrough():null
    this.stderr=modes[2]==='pipe'?new PassThrough():null
    this.#serialization=options.serialization==='advanced'?'advanced':'json'
    this.#worker=new Worker(resolve(options.cwd??process.cwd(),filename),{
      command:true,inheritedInput:modes[0]==='inherit',fork:ipc,execArgv:options.execArgv??[],evalSource:options.evalSource,stdinSource:options.stdinSource,ipcSerialization:this.#serialization,argv:args,cwd:options.cwd??process.cwd(),env:options.env??{...process.env},
    })
    this.pid=this.#worker.threadId
    this.connected=ipc
    if(!ipc){Object.defineProperty(this,'send',{value:undefined});Object.defineProperty(this,'disconnect',{value:undefined})}
    this.#release=keepNodeCommandAlive()
    for(const stream of [this.stdout,this.stderr]){
      if(!stream)continue
      this.#outputOpen++
      let finished=false
      const complete=()=>{if(finished)return;finished=true;this.#outputOpen--;this.#maybeClose()}
      stream.once('end',complete);stream.once('close',complete)
    }
    this.stdin=modes[0]==='pipe'?new Writable({write:(chunk:Uint8Array,_encoding:string,done:(error?:Error)=>void)=>{
      try{void this.#worker.writeInput(new Uint8Array(chunk)).then(()=>done(),error=>done(error))}catch(error){done(error as Error)}
    },final:(done:(error?:Error)=>void)=>{
      try{void this.#worker.writeInput(null).then(()=>done(),error=>done(error))}catch(error){done(error as Error)}
    }}):null
    this.stdio=[this.stdin,this.stdout,this.stderr,...(ipc?[null]:[])]
    this.#worker.on('online',()=>{
      this.emit('spawn')
      if(modes[0]==='ignore')void Promise.resolve(this.#worker.writeInput(null)).catch(error=>this.emit('error',error))
    })
    if(inputSource){
      const reader={},controller=new AbortController()
      let pending=false,ended=false
      this.#worker.on('input-demand',()=>{
        if(pending||ended||this.#exited)return
        pending=true
        void inputSource.read(reader,controller.signal).then(bytes=>{
          pending=false
          if(this.#exited)return
          if(bytes===null)ended=true
          return this.#worker.writeInput(bytes)
        }).catch(error=>{pending=false;if(!controller.signal.aborted&&!this.#exited)this.emit('error',error)})
      })
      this.once('exit',()=>controller.abort())
    }
    this.#worker.on('message',(message:unknown)=>this.emit('message',message))
    this.#worker.on('disconnect',()=>this.#disconnect())
    const output=(name:'stdout'|'stderr',value:string|Uint8Array,done?:()=>void)=>{
      const stream=this[name]
      if(stream){stream.write(value,()=>done?.());return}
      if(modes[name==='stdout'?1:2]!=='inherit'){done?.();return}
      const parent=(process as typeof process & {stdout:Writable;stderr:Writable})[name]
      this.#outputOpen++
      let settled=false
      const finish=(error?:Error|null)=>{
        if(settled)return
        settled=true
        this.#outputOpen--
        try{if(error)this.emit('error',error)}finally{done?.();this.#maybeClose()}
      }
      try{parent.write(typeof value==='string'?value:Buffer.from(value),finish)}catch(error){finish(error as Error)}
    }
    this.#worker.on('stdout',(text:string)=>output('stdout',text))
    this.#worker.on('stderr',(text:string)=>output('stderr',text))
    this.#worker.on('stdout-bytes',(bytes:Uint8Array,done?:()=>void)=>output('stdout',bytes,done))
    this.#worker.on('stderr-bytes',(bytes:Uint8Array,done?:()=>void)=>output('stderr',bytes,done))
    this.#worker.on('error',(error:Error)=>this.emit('error',error))
    this.#worker.once('exit',(code:number)=>{
      this.#exited=true
      this.#disconnect()
      this.exitCode=this.signalCode===null?code:null
      this.stdin?.destroy()
      this.stdout?.end();this.stderr?.end()
      this.emit('exit',this.exitCode,this.signalCode)
      // Node flushes unread stdio after exit so close cannot wait forever for
      // an output stream the caller never consumed.
      queueMicrotask(()=>{this.stdout?.resume();this.stderr?.resume();this.#maybeClose()})
    })
    const signal=options.signal,killSignal=options.killSignal??'SIGTERM'
    const abort=()=>{
      if(this.kill(killSignal))this.emit('error',Object.assign(Error('The operation was aborted'),
        {name:'AbortError',code:'ABORT_ERR',cause:signal?.reason}))
    }
    let timer:ReturnType<typeof setTimeout>|undefined
    if(options.timeout)timer=setTimeout(()=>this.kill(killSignal),options.timeout)
    if(signal){if(signal.aborted)queueMicrotask(abort);else signal.addEventListener('abort',abort,{once:true})}
    this.once('exit',()=>{if(timer!==undefined)clearTimeout(timer);signal?.removeEventListener('abort',abort)})
  }
  #disconnect(){
    if(!this.#ipc||this.#disconnectEmitted)return
    this.#disconnectEmitted=true
    this.connected=false
    this.emit('disconnect')
  }
  #maybeClose(){
    if(!this.#exited||this.#outputOpen||this.#closed)return
    this.#closed=true
    queueMicrotask(()=>{
      this.#release?.();this.#release=undefined
      this.emit('close',this.exitCode,this.signalCode)
    })
  }
  ref(){if(!this.#exited&&!this.#release)this.#release=keepNodeCommandAlive();return this}
  unref(){this.#release?.();this.#release=undefined;return this}
  disconnect(){
    if(!this.connected){this.emit('error',Object.assign(Error('IPC channel is already disconnected'),{code:'ERR_IPC_DISCONNECTED'}));return}
    this.connected=false
    this.#worker.disconnectIpc()
  }
  send(message:unknown,callback?:(error:Error|null)=>void){
    if(process.env.NATIVE_IPC_TRACE==='1')self.postMessage({type:'native-dev-progress',phase:`ipc-parent-send:${this.pid}`})
    if(!this.connected){
      const error=Object.assign(new Error('IPC channel is closed'),{code:'ERR_IPC_CHANNEL_CLOSED'})
      queueMicrotask(()=>callback?callback(error):this.emit('error',error))
      return false
    }
    this.#worker.postMessage(ipcMessage(message,this.#serialization))
    if(callback)queueMicrotask(()=>callback(null))
    return true
  }
  kill(signal='SIGTERM'){
    if(this.exitCode!==null||this.killed)return false
    if(signal!=='SIGTERM'&&signal!=='SIGKILL')unsupported(`Signal ${signal}`)
    this.killed=true;this.signalCode=signal
    void this.#worker.terminate()
    return true
  }
}

type PipedChildProcess=ChildProcess&{stdin:Writable;stdout:PassThrough;stderr:PassThrough}
export function fork(filename:string|URL,args:string[],options:ForkOptions&{stdio:'pipe'}):PipedChildProcess
export function fork(filename:string|URL,options:ForkOptions&{stdio:'pipe'}):PipedChildProcess
export function fork(filename:string|URL,args:string[],options:ForkOptions&{silent:true;stdio?:'pipe'}):PipedChildProcess
export function fork(filename:string|URL,options:ForkOptions&{silent:true;stdio?:'pipe'}):PipedChildProcess
export function fork(filename:string|URL,args?:string[]|ForkOptions,options?:ForkOptions):ChildProcess
export function fork(filename:string|URL,args:string[]|ForkOptions=[],options:ForkOptions={}):ChildProcess{
  if(filename instanceof URL){
    if(filename.protocol!=='file:')throw Object.assign(new TypeError('The URL must use the file scheme'),{code:'ERR_INVALID_URL_SCHEME'})
    if(filename.hostname!==''&&filename.hostname!=='localhost')throw Object.assign(new TypeError('File URL host must be empty or localhost'),{code:'ERR_INVALID_FILE_URL_HOST'})
    if(/%2f/i.test(filename.pathname))throw Object.assign(new TypeError('File URL path must not include encoded / characters'),{code:'ERR_INVALID_FILE_URL_PATH'})
    filename=fileURLToPath(filename)
  }
  if(!Array.isArray(args)){options=args;args=[]}
  if(options.stdio===undefined)options={...options,stdio:options.silent?'pipe':'inherit'}
  if(options.execArgv===undefined){
    const inherited=(process as typeof process & {execArgv?:string[]}).execArgv??[]
    const flags:string[]=[]
    for(let index=0;index<inherited.length;index++){
      const flag=inherited[index]!
      if(flag==='-e'||flag==='--eval'){index++;continue}
      if(flag.startsWith('--eval='))continue
      flags.push(flag)
    }
    options={...options,execArgv:flags}
  }
  if(options.execArgv?.some(flag=>flag==='-e'||flag==='--eval'||flag.startsWith('--eval=')))unsupported('Explicit fork eval flags')
  if(typeof filename!=='string'||args.some(value=>typeof value!=='string'))throw new TypeError('fork requires a module path and string arguments')
  launchConditions(options.execArgv)
  validateLifetime(options)
  if(options.detached||options.execPath)unsupported('Custom executables or detached processes')
  if(Array.isArray(options.stdio)){
    if(!options.stdio.includes('ipc'))throw Object.assign(new Error('Fork stdio requires an IPC channel'),{code:'ERR_CHILD_PROCESS_IPC_REQUIRED'})
    if(options.stdio.length!==4||options.stdio[3]!=='ipc'||options.stdio.slice(0,3).includes('ipc'))
      unsupported('Requested IPC descriptor placement')
    options={...options,stdio:options.stdio.slice(0,3)}
  }
  stdioModes(options.stdio)
  if(options.serialization!==undefined&&options.serialization!=='advanced'&&options.serialization!=='json')unsupported('Requested IPC serialization')
  return new ChildProcess(filename,args,options)
}
export const exec=()=>unsupported('exec')
export const execSync=()=>unsupported('execSync')
type ExecFileOptions=SpawnOptions&{encoding?:string|null;maxBuffer?:number;killSignal?:string}
type ExecFileCallback=(error:Error|null,stdout:string|Buffer,stderr:string|Buffer)=>void
export function execFile(file:string,args:string[]|ExecFileOptions|ExecFileCallback=[],
  options:ExecFileOptions|ExecFileCallback={},callback?:ExecFileCallback){
  if(typeof args==='function'){callback=args;args=[];options={}}
  else if(!Array.isArray(args)){callback=typeof options==='function'?options:callback;options=args;args=[]}
  if(typeof options==='function'){callback=options;options={}}
  const maxBuffer=options.maxBuffer??1024*1024,timeout=options.timeout??0,killSignal=options.killSignal??'SIGTERM'
  if(typeof maxBuffer!=='number'||Number.isNaN(maxBuffer)||maxBuffer<0)throw RangeError('Invalid maxBuffer')
  if(!Number.isInteger(timeout)||timeout<0)throw RangeError('Invalid timeout')
  if(!['SIGTERM','SIGKILL'].includes(killSignal))unsupported(`Signal ${killSignal}`)
  const {timeout:_timeout,encoding:requestedEncoding,maxBuffer:_maxBuffer,killSignal:_killSignal,...launch}=options
  const child=spawn(file,args,{...launch,stdio:'pipe'})
  const encoding=requestedEncoding===undefined?'utf8':requestedEncoding
  const text=encoding!==null&&encoding!=='buffer'&&Buffer.isEncoding(encoding)
  const output:{stdout:Array<string|Buffer>;stderr:Array<string|Buffer>}={stdout:[],stderr:[]}
  const lengths={stdout:0,stderr:0}
  let failure:Error|undefined,finished=false
  let timer:ReturnType<typeof setTimeout>|undefined
  const command=[file,...args].join(' ')
  const kill=()=>{child.stdout.destroy();child.stderr.destroy();child.kill(killSignal)}
  for(const name of ['stdout','stderr'] as const){
    if(text)child[name].setEncoding(encoding as BufferEncoding)
    child[name].on('data',(chunk:string|Buffer)=>{
      if(failure)return
      const length=typeof chunk==='string'?Buffer.byteLength(chunk,encoding as BufferEncoding):chunk.length
      const remaining=maxBuffer-lengths[name]
      lengths[name]+=length
      if(length>remaining){
        output[name].push(chunk.slice(0,Math.max(0,remaining)))
        failure=Object.assign(new RangeError(`${name} maxBuffer length exceeded`),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'})
        kill()
      }else output[name].push(chunk)
    })
  }
  child.on('error',(error:Error)=>{failure=error;child.stdout.destroy();child.stderr.destroy()})
  child.once('close',(code:number|null,signal:string|null)=>{
    if(finished)return
    finished=true
    if(timer!==undefined)clearTimeout(timer)
    const collect=(name:'stdout'|'stderr')=>text?output[name].join(''):Buffer.concat(output[name] as Buffer[])
    const stdout=collect('stdout'),stderr=collect('stderr')
    if(!failure&&(code!==0||signal!==null))failure=Object.assign(Error(`Command failed: ${command}\n${stderr}`),
      {code,killed:child.killed,signal})
    if(failure)Object.assign(failure,{cmd:command})
    callback?.(failure??null,stdout,stderr)
  })
  if(timeout>0)timer=setTimeout(kill,timeout)
  return child
}
Object.defineProperty(execFile,promisify.custom,{value:(...args:unknown[])=>{
  let child:ChildProcess|undefined
  const promise=new Promise((resolve,reject)=>{
    child=Reflect.apply(execFile,undefined,[...args,(error:Error|null,stdout:string|Buffer,stderr:string|Buffer)=>{
      if(error){Object.assign(error,{stdout,stderr});reject(error)}else resolve({stdout,stderr})
    }])
  })
  Object.defineProperty(promise,'child',{value:child,enumerable:true})
  return promise
}})
export function spawn(command:string,args?:string[],options?:SpawnOptions&{stdio?:'pipe'}):PipedChildProcess
export function spawn(command:string,options:SpawnOptions&{stdio?:'pipe'}):PipedChildProcess
export function spawn(command:string,args?:string[]|SpawnOptions,options?:SpawnOptions):ChildProcess
export function spawn(command:string,args:string[]|SpawnOptions=[],options:SpawnOptions={}):ChildProcess{
  if(!Array.isArray(args)){options=args;args=[]}
  if(typeof command!=='string'||!command||args.some(value=>typeof value!=='string'))throw TypeError('spawn requires a command and string arguments')
  if(!['node','/usr/bin/node'].includes(command))unsupported(`Executable ${command}`)
  if(options.shell)unsupported('Shell execution')
  validateLifetime(options)
  if(options.detached||options.execPath)unsupported('Custom executables or detached processes')
  stdioModes(options.stdio)
  const {entry,argv,...launch}=parseNodeInvocation(args)
  return new ChildProcess(entry,argv,{...options,...launch},false)
}
export default {ChildProcess,fork,exec,execSync,execFile,spawn}
