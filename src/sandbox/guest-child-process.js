import {EventEmitter} from 'node:events'
import {Readable,Writable} from 'node:stream'
import {Buffer} from 'node:buffer'
import process from 'node:process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'

const host=globalThis.__webContainerHost
const unsupported=feature=>Object.assign(Error(feature+' is not implemented in this sandbox'),{code:'ERR_UNSUPPORTED_OPERATION'})
function processSignal(value='SIGTERM'){
  if(value===0)return 0
  if(typeof value==='string'){
    const signal=value.toUpperCase()
    if(signal==='SIGTERM'||signal==='SIGKILL'||signal==='SIGINT')return signal
  }else if(value===15)return 'SIGTERM'
  else if(value===9)return 'SIGKILL'
  else if(value===2)return 'SIGINT'
  throw Object.assign(Error('Unknown signal: '+String(value)),{code:'ERR_UNKNOWN_SIGNAL'})
}
function optionsFor(options){
  const supported=new Set(['cwd','env','stdio','shell','detached','windowsHide','timeout','killSignal','signal'])
  for(const key of Object.keys(options))if(!supported.has(key))throw unsupported('Process option '+key)
  if(options.shell!==undefined&&options.shell!==false&&options.shell!==true&&options.shell!=='/bin/sh')throw unsupported('Shell path')
  if(options.detached)throw unsupported('Detached processes')
  const entries=options.stdio===undefined?[]:typeof options.stdio==='string'?[options.stdio,options.stdio,options.stdio]:options.stdio
  if(!Array.isArray(entries)||entries.length>3)throw unsupported('Process stdio')
  const stdio=[0,1,2].map(index=>{
    const value=entries[index]??'pipe';if(value===index)return 'inherit'
    if(!['pipe','ignore','inherit'].includes(value))throw unsupported('Process stdio entry')
    return value
  })
  if(options.timeout!==undefined&&(!Number.isSafeInteger(options.timeout)||options.timeout<0))throw new TypeError('Invalid process timeout')
  if(options.killSignal!==undefined&&processSignal(options.killSignal)===0)throw Object.assign(Error('Unknown signal: 0'),{code:'ERR_UNKNOWN_SIGNAL'})
  if(options.signal!==undefined&&(!options.signal||typeof options.signal.aborted!=='boolean'||typeof options.signal.addEventListener!=='function'||typeof options.signal.removeEventListener!=='function'))throw new TypeError('Expected AbortSignal')
  return {cwd:options.cwd,env:options.env??process.env,stdio}
}

export class ChildProcess extends EventEmitter {
  constructor(){super();this.pid=undefined;this.exitCode=null;this.signalCode=null;this.killed=false;this.connected=false;this._closed=false}
  spawn(options){
    const {file,args=[],...settings}=options
    return this._start(file,args.slice(1),settings)
  }
  _start(command,args,options={},ipcMode){
    const settings=optionsFor(options)
    this.spawnfile=command;this.spawnargs=[command,...args]
    const output=()=>new Readable({
      read(){const resume=this._resumePipe;this._resumePipe=undefined;resume?.()},
      destroy(error,done){const resume=this._resumePipe;this._resumePipe=undefined;resume?.();done(error)}
    })
    this.stdout=settings.stdio[1]==='pipe'?output():null
    this.stderr=settings.stdio[2]==='pipe'?output():null
    this.stdin=settings.stdio[0]==='pipe'?new Writable({
      write:(bytes,_encoding,done)=>{
        const write=async()=>{if(this.pid===undefined||this.exitCode!==null||this.signalCode!==null)throw Object.assign(Error('Process input is closed'),{code:'EPIPE'});for(let offset=0;offset<bytes.length;offset+=16384)await host.proc.write(this.pid,bytes.subarray(offset,offset+16384))}
        write().then(()=>done(),done).catch(error=>host.reportError(error))
      },
      final:done=>{try{if(this.pid!==undefined)host.proc.call('end',this.pid);done()}catch(error){done(error)}}
    }):null
    this.stdio=[this.stdin,this.stdout,this.stderr]
    try{
      if(!host.proc)throw unsupported('Guest processes')
      this.pid=options.shell
        ?host.proc.call('shellSpawn',[command,...args].join(' '),settings)
        :host.proc.call(ipcMode?'fork':'spawn',command,args,settings,ipcMode)
      if(ipcMode)attachIPC(this,this.pid,ipcMode,host,Buffer,process.nextTick,encodeIPC,decodeIPC)
    }catch(error){process.nextTick(()=>{this.emit('error',error);this._finish(-2,null,false)});return this}
    if(options.timeout)this._timer=setTimeout(()=>this.kill(options.killSignal??'SIGTERM'),options.timeout)
    if(options.signal){
      this._signal=options.signal
      this._abort=()=>{this.kill(options.killSignal??'SIGTERM');this.emit('error',Object.assign(Error('The operation was aborted'),{name:'AbortError',code:'ABORT_ERR',cause:options.signal.reason}))}
      options.signal.addEventListener('abort',this._abort,{once:true})
    }
    process.nextTick(()=>{this.emit('spawn');if(this._signal?.aborted)this._abort();this._pump().catch(error=>host.reportError(error))})
    return this
  }
  async _pump(){
    for(;;){
      const event=await host.proc.next(this.pid)
      if(!event)return
      if(event.type==='exit'){if(this._ipcDone)await this._ipcDone;globalThis[Symbol.for('web-container:task-queue')].task(this._finish,this,[event.code,event.signal,true]);return}
      const stream=event.type==='stdout'?this.stdout:this.stderr
      if(!stream)throw Error('Received output for non-pipe stdio')
      if(!stream.destroyed&&!globalThis[Symbol.for('web-container:task-queue')].task(stream.push,stream,[Buffer.from(event.bytes)])&&!this.killed)
        await new Promise(resolve=>stream._resumePipe=resolve)
    }
  }
  _finish(code,signal,spawned){
    clearTimeout(this._timer);this._signal?.removeEventListener('abort',this._abort)
    this.exitCode=code;this.signalCode=signal
    this.stdin?.destroy()
    if(spawned)this.emit('exit',code,signal)
    let remaining=2
    const ended=()=>{if(--remaining)return;this._closed=true;try{this.emit('close',code,signal)}finally{if(this.pid!==undefined)host.proc.call('forget',this.pid)}}
    for(const stream of [this.stdout,this.stderr]){
      if(!stream||stream.readableEnded||stream.destroyed){ended();continue}
      stream.once('end',ended);stream.push(null);stream.resume()
    }
  }
  kill(signal='SIGTERM'){signal=processSignal(signal);if(this.pid===undefined||this.exitCode!==null||this.signalCode!==null)return false;const killed=host.proc.call('kill',this.pid,signal);if(killed){this.killed=true;for(const stream of [this.stdout,this.stderr]){const resume=stream?._resumePipe;if(stream)stream._resumePipe=undefined;resume?.()}}return killed}
  ref(){if(this.pid!==undefined&&!this._closed)host.proc.call('ref',this.pid,true);return this}
  unref(){if(this.pid!==undefined&&!this._closed)host.proc.call('ref',this.pid,false);return this}
  send(){throw unsupported('Process IPC')}
  disconnect(){throw unsupported('Process IPC')}
}
export function spawn(command,args,options){
  if(!Array.isArray(args)){options=args??{};args=[]}
  if(typeof command!=='string'||(!command&&!options?.shell)||command.includes('\0')||args.some(arg=>typeof arg!=='string'||arg.includes('\0')))throw new TypeError('Invalid process command or arguments')
  return new ChildProcess()._start(command,args,options??{})
}
export function execFile(file,args,options,callback){
  if(typeof args==='function'){callback=args;args=[];options={}}
  else if(!Array.isArray(args)){callback=options;options=args??{};args=[]}
  if(typeof options==='function'){callback=options;options={}}
  options??={}
  const {encoding='utf8',maxBuffer=1024*1024,...settings}=options
  if(!Number.isSafeInteger(maxBuffer)||maxBuffer<0)throw new TypeError('Invalid maxBuffer')
  if(encoding!=='buffer'&&encoding!==null&&!Buffer.isEncoding(encoding))throw new TypeError('Invalid encoding')
  const child=spawn(file,args,{...settings,stdio:'pipe'}),chunks={stdout:[],stderr:[]},sizes={stdout:0,stderr:0}
  let failure
  child.on('error',error=>{failure??=error})
  for(const name of ['stdout','stderr'])child[name].on('data',bytes=>{
    const remaining=Math.max(0,maxBuffer-sizes[name]);chunks[name].push(bytes.subarray(0,remaining));sizes[name]+=bytes.length
    if(sizes[name]>maxBuffer&&!failure){failure=Object.assign(Error(name+' maxBuffer exceeded'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});child.kill(settings.killSignal??'SIGTERM')}
  })
  child.once('close',(code,signal)=>{
    const output=name=>{const buffer=Buffer.concat(chunks[name]);return encoding===null||encoding==='buffer'?buffer:buffer.toString(encoding)}
    const stdout=output('stdout'),stderr=output('stderr'),cmd=[file,...args].join(' ')
    if(!failure&&(code!==0||signal))failure=Object.assign(Error('Command failed: '+cmd+'\n'+stderr),{code,signal,killed:child.killed,cmd})
    if(failure)failure.cmd??=cmd
    callback?.(failure??null,stdout,stderr)
  })
  return child
}
export function exec(command,options,callback){
  if(typeof command!=='string'||command.includes('\0'))throw new TypeError('Invalid command')
  if(typeof options==='function'){callback=options;options={}}
  if(options!==undefined&&(options===null||typeof options!=='object'||Array.isArray(options)))throw new TypeError('Invalid exec options')
  if(callback!==undefined&&typeof callback!=='function')throw new TypeError('Callback must be a function')
  return execFile(command,[],{...options,shell:typeof options?.shell==='string'?options.shell:true},callback)
}
execFile[promisify.custom]=(...args)=>{
  let child
  const promise=new Promise((resolve,reject)=>{child=execFile(...args,(error,stdout,stderr)=>{if(error){Object.assign(error,{stdout,stderr});reject(error)}else resolve({stdout,stderr})})})
  promise.child=child
  return promise
}
exec[promisify.custom]=(...args)=>{
  let child
  const promise=new Promise((resolve,reject)=>{child=exec(...args,(error,stdout,stderr)=>{if(error){Object.assign(error,{stdout,stderr});reject(error)}else resolve({stdout,stderr})})})
  promise.child=child
  return promise
}
export function execSync(){throw unsupported('Synchronous shell execution')}
export function execFileSync(){throw unsupported('Synchronous processes')}
export function spawnSync(){throw unsupported('Synchronous processes')}
export function fork(modulePath,args,options){
  if(!Array.isArray(args)){options=args??{};args=[]}
  const {serialization='json',execArgv=process.execArgv,execPath=process.execPath,silent=false,...settings}=options??{}
  if(serialization!=='json'&&serialization!=='advanced')throw new TypeError('Invalid serialization mode')
  if(!Array.isArray(execArgv)||execArgv.some(value=>typeof value!=='string'))throw new TypeError('Invalid execArgv')
  if(modulePath instanceof URL)modulePath=fileURLToPath(modulePath)
  if(typeof modulePath!=='string')throw new TypeError('Expected module path')
  return new ChildProcess()._start(execPath,[...execArgv,modulePath,...args],{...settings,stdio:settings.stdio??(silent?'pipe':'inherit')},serialization)
}
export default {ChildProcess,spawn,execFile,exec,execSync,execFileSync,spawnSync,fork}
