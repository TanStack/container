import {WorkerKernel} from './index'
import type {KernelOwnerOptions} from '../sandbox/kernel-limits'
import type {KernelResourceSnapshot} from '../sandbox/kernel'
import type {WorkspaceSnapshot} from '../sandbox/files'
import type {ProjectInstallOptions} from '../npm/project'
import {SandboxTelemetry,type SandboxTelemetryOptions} from './telemetry'

type JSONValue=null|boolean|number|string|JSONValue[]|{[key:string]:JSONValue}
export type AgentToolResult={ok:true,value:JSONValue}|{ok:false,error:{name:string;message:string;code?:string}}
type EncodeSnapshot<Snapshot>=Snapshot extends {files:Record<string,Uint8Array>}?Omit<Snapshot,'files'>&{files:Record<string,{base64:string}>}:never
export type AgentWorkspaceSnapshot=EncodeSnapshot<WorkspaceSnapshot>
export type AgentWorkspaceBinarySnapshot=WorkspaceSnapshot
export type AgentSnapshotOptions={encoding?:'base64'|'binary'}
export interface AgentSessionOptions extends KernelOwnerOptions {maxOutputBytes?:number;kernel?:WorkerKernel;telemetry?:SandboxTelemetry|SandboxTelemetryOptions}
const path=(value:string)=>{
  if(typeof value!=='string'||!value.startsWith('/')||value.includes('\\')||value.includes('\0')||value.split('/').includes('..')||new TextEncoder().encode(value).length>4096)throw Object.assign(Error('Expected an absolute virtual POSIX path'),{code:'EINVAL'})
  return value
}
const jsonSafe=(value:unknown):JSONValue=>{
  if(value===undefined)return null
  if(value===null||typeof value==='string'||typeof value==='boolean')return value
  if(typeof value==='number')return Number.isFinite(value)?value:String(value)
  if(value instanceof Uint8Array)return {base64:bytesToBase64(value)}
  if(Array.isArray(value))return value.map(jsonSafe)
  if(typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,jsonSafe(item)]))
  return String(value)
}
const bytesToBase64=(bytes:Uint8Array)=>{let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text)}
const base64ToBytes=(text:string)=>Uint8Array.from(atob(text),character=>character.charCodeAt(0))
const encodeSnapshot=(snapshot:WorkspaceSnapshot):AgentWorkspaceSnapshot=>({...snapshot,files:Object.fromEntries(Object.entries(snapshot.files).map(([name,value])=>[name,{base64:bytesToBase64(value)}]))}) as AgentWorkspaceSnapshot
const decodeSnapshot=(snapshot:AgentWorkspaceSnapshot|AgentWorkspaceBinarySnapshot):WorkspaceSnapshot=>{
  let encoding:'base64'|'binary'|undefined
  const files=Object.fromEntries(Object.entries(snapshot.files).map(([name,value])=>{
    const current=value instanceof Uint8Array?'binary':value&&typeof value==='object'&&typeof (value as {base64?:unknown}).base64==='string'?'base64':undefined
    if(!current)throw new TypeError('Snapshot files must contain Uint8Array bytes or base64 objects')
    if(encoding&&encoding!==current)throw new TypeError('Snapshot files must use one encoding')
    encoding=current
    return [name,current==='binary'?value:base64ToBytes((value as {base64:string}).base64)]
  }))
  return {...snapshot,files} as WorkspaceSnapshot
}
const abortable=async<T>(operation:Promise<T>,signal?:AbortSignal):Promise<T>=>{
  signal?.throwIfAborted();if(!signal)return operation
  return new Promise<T>((resolve,reject)=>{const abort=()=>reject(signal.reason??new DOMException('Aborted','AbortError'));signal.addEventListener('abort',abort,{once:true});operation.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort))})
}
// Acquiring a handle cannot be raced against abort: the eventual handle still needs an owner.
const acquire=async<T>(operation:()=>Promise<T>,release:(value:T)=>Promise<unknown>,signal?:AbortSignal):Promise<T>=>{
  signal?.throwIfAborted()
  let value:T
  try{value=await operation()}catch(error){signal?.throwIfAborted();throw error}
  if(signal?.aborted){try{await release(value)}finally{signal.throwIfAborted()}}
  return value
}

export const AGENT_TOOL_DEFINITIONS=[
  ['list',{path:{type:'string'}}],['read',{path:{type:'string'},encoding:{enum:['utf8','base64']}}],['write',{path:{type:'string'},text:{type:'string'},base64:{type:'string'}}],
  ['mkdir',{path:{type:'string'}}],['remove',{path:{type:'string'}}],['move',{from:{type:'string'},to:{type:'string'}}],['install',{options:{type:'object'}}],
  ['run',{command:{type:'string'},args:{type:'array',items:{type:'string'}},cwd:{type:'string'}}],['snapshot',{}],['restore',{snapshot:{type:'object'}}],['resources',{}],['close',{}],
].map(([name,properties])=>({name,description:`Browser sandbox ${name} tool`,inputSchema:{type:'object',properties,additionalProperties:false}})) as unknown as readonly {name:string;description:string;inputSchema:Record<string,unknown>}[]

export class AgentSession {
  readonly kernel:WorkerKernel
  readonly maxOutputBytes:number
  readonly telemetry?:SandboxTelemetry
  #mutations=Promise.resolve()
  #closed=false
  #closing:Promise<{closed:true}>|undefined
  constructor(files:Record<string,string|Uint8Array>={},options:AgentSessionOptions={}){
    const {maxOutputBytes=1024*1024,kernel,telemetry,...kernelOptions}=options
    if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>16*1024*1024)throw Error('maxOutputBytes must be between 1 and 16777216')
    this.maxOutputBytes=maxOutputBytes;this.kernel=kernel??new WorkerKernel(files,kernelOptions);this.telemetry=telemetry instanceof SandboxTelemetry?telemetry:telemetry?new SandboxTelemetry(telemetry):undefined
  }
  #check(){if(this.#closed)throw Error('Agent session closed')}
  #mutate<T>(operation:()=>Promise<T>){this.#check();const next=this.#mutations.then(operation,operation);this.#mutations=next.then(()=>{},()=>{});return next}
  async #files<T>(writable:boolean,method:string,args:unknown[],signal?:AbortSignal){const session=await acquire(()=>this.kernel.openFileSession({writable}),session=>session.close(),signal);try{signal?.throwIfAborted();return await abortable(session.call(method,args),signal) as T}finally{await session.close()}}
  list(input:{path?:string}={},signal?:AbortSignal){this.#check();const root=path(input.path??'/');return this.#files<{name:string;relativePath:string;kind:'file'|'directory'|'symlink'}[]>(false,'readdir',[root,{recursive:true,withFileTypes:true}],signal).then(entries=>entries.map(entry=>({path:(root==='/'?'':root.replace(/\/$/,''))+'/'+entry.relativePath,kind:entry.kind})))}
  async read(input:{path:string;encoding?:'utf8'|'base64'},signal?:AbortSignal){this.#check();const bytes=await abortable(this.kernel.readFile(path(input.path)),signal);if(bytes.length>this.maxOutputBytes)throw Object.assign(Error('File output exceeds maxOutputBytes'),{code:'ERR_OUTPUT_LIMIT'});return input.encoding==='base64'?{base64:bytesToBase64(bytes)}:{text:new TextDecoder().decode(bytes)}}
  write(input:{path:string;text?:string;base64?:string},signal?:AbortSignal){return this.#mutate(async()=>{signal?.throwIfAborted();if((input.text===undefined)===(input.base64===undefined))throw Error('Provide exactly one of text or base64');const target=path(input.path),bytes=input.text!==undefined?new TextEncoder().encode(input.text):base64ToBytes(input.base64!);await abortable(this.kernel.writeFile(target,bytes),signal);this.telemetry?.record({type:'file.write',path:target,bytes:bytes.length});return {bytes:bytes.length}})}
  mkdir(input:{path:string},signal?:AbortSignal){return this.#mutate(async()=>{const target=path(input.path);await this.#files(true,'mkdir',[target,{recursive:true}],signal);this.telemetry?.record({type:'file.mkdir',path:target});return {created:true}})}
  remove(input:{path:string},signal?:AbortSignal){return this.#mutate(async()=>{const target=path(input.path);await this.#files(true,'rm',[target,{recursive:true,force:false}],signal);this.telemetry?.record({type:'file.remove',path:target});return {removed:true}})}
  move(input:{from:string;to:string},signal?:AbortSignal){return this.#mutate(async()=>{const from=path(input.from),to=path(input.to);await this.#files(true,'rename',[from,to],signal);this.telemetry?.record({type:'file.move',from,to});return {moved:true}})}
  install(input:{options?:ProjectInstallOptions}={},signal?:AbortSignal){return this.#mutate(async()=>{signal?.throwIfAborted();const result=await this.kernel.install(input.options,signal);this.telemetry?.record({type:'install.complete',installed:result.installed,skipped:result.skippedPlatformPackages.length,ignoredScripts:result.ignoredScripts.length});return result})}
  async run(input:{command:string;args?:string[];cwd?:string},signal?:AbortSignal){
    this.#check();if(typeof input.command!=='string'||!input.command||input.command.includes('\0')||input.args?.some(value=>typeof value!=='string'))throw Error('Invalid process command or arguments')
    const cwd=input.cwd&&path(input.cwd),args=input.args??[],process=await acquire(()=>this.kernel.spawn(input.command,args,{cwd}),async process=>{try{await process.kill('SIGKILL')}finally{await process.dispose()}},signal),decoders={stdout:new TextDecoder(),stderr:new TextDecoder()},stdout:string[]=[],stderr:string[]=[];let bytes=0,truncated=false
    if(signal?.aborted){try{try{await process.kill('SIGKILL')}finally{await process.dispose()}}finally{signal.throwIfAborted()}}
    this.telemetry?.record({type:'process.start',command:input.command,args,cwd})
    const abort=()=>void process.kill('SIGKILL');signal?.addEventListener('abort',abort,{once:true})
    try{for(;;){const event=await process.next();if(!event)break;if(event.type==='stdout'||event.type==='stderr'){const remaining=Math.max(0,this.maxOutputBytes-bytes),chunk=event.bytes.subarray(0,remaining);bytes+=chunk.length;(event.type==='stdout'?stdout:stderr).push(decoders[event.type].decode(chunk,{stream:true}));if(chunk.length<event.bytes.length)truncated=true}if(event.type==='exit')break}stdout.push(decoders.stdout.decode());stderr.push(decoders.stderr.decode());const result=await process.wait();this.telemetry?.record({type:'process.exit',status:result.exitCode,signal:result.signal,truncated});return {stdout:stdout.join(''),stderr:stderr.join(''),status:result.exitCode,signal:result.signal,truncated}}
    finally{signal?.removeEventListener('abort',abort);await process.dispose()}
  }
  async snapshot(input:{encoding:'binary'},signal?:AbortSignal):Promise<AgentWorkspaceBinarySnapshot>
  async snapshot(input?:{encoding?:'base64'},signal?:AbortSignal):Promise<AgentWorkspaceSnapshot>
  async snapshot(input:AgentSnapshotOptions,signal?:AbortSignal):Promise<AgentWorkspaceSnapshot|AgentWorkspaceBinarySnapshot>
  async snapshot(input:AgentSnapshotOptions={},signal?:AbortSignal):Promise<AgentWorkspaceSnapshot|AgentWorkspaceBinarySnapshot>{this.#check();const encoding=input.encoding??'base64';if(encoding!=='base64'&&encoding!=='binary')throw new TypeError("snapshot encoding must be 'base64' or 'binary'");const snapshot=await abortable(this.kernel.snapshot(),signal);this.telemetry?.record({type:'snapshot.capture',files:Object.keys(snapshot.files).length,directories:'directories' in snapshot?snapshot.directories.length:0});return encoding==='binary'?snapshot:encodeSnapshot(snapshot)}
  restore(input:{snapshot:AgentWorkspaceSnapshot|AgentWorkspaceBinarySnapshot},signal?:AbortSignal){return this.#mutate(async()=>{signal?.throwIfAborted();const snapshot=decodeSnapshot(input.snapshot);await abortable(this.kernel.restore(snapshot),signal);this.telemetry?.record({type:'snapshot.restore',files:Object.keys(snapshot.files).length,directories:'directories' in snapshot?snapshot.directories.length:0});return {restored:true}})}
  async resources(_input={},signal?:AbortSignal):Promise<KernelResourceSnapshot>{this.#check();const value=await abortable(this.kernel.resources(),signal);this.telemetry?.record({type:'resources.sample',...value});return value}
  close(){
    if(this.#closing)return this.#closing
    this.#closed=true
    this.kernel.close()
    this.telemetry?.record({type:'session.close'})
    return this.#closing=(this.kernel.shutdown??Promise.resolve()).then(()=>({closed:true as const}))
  }
  async call(name:string,input:Record<string,unknown>={},signal?:AbortSignal):Promise<AgentToolResult>{try{const method=(this as unknown as Record<string,(input:never,signal?:AbortSignal)=>unknown>)[name];if(typeof method!=='function'||name==='call')throw Object.assign(Error('Unknown agent tool: '+name),{code:'ERR_UNKNOWN_TOOL'});return {ok:true,value:jsonSafe(await method.call(this,input as never,signal))}}catch(error){const item=error as Error&{code?:string};return {ok:false,error:{name:item.name??'Error',message:item.message??String(error),...(item.code?{code:item.code}:{})}}}}
}
