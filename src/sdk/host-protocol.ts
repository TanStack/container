import type {CheckpointMetadata} from '../sandbox/checkpoint-storage'
import type {WorkspaceSnapshot} from '../sandbox/files'
import type {SpawnOptions,ProcessEvent} from '../sandbox/guest-processes'
import type {KernelExecutionResult,KernelOptions,KernelProcessResult,KernelResourceSnapshot} from '../sandbox/kernel'
import type {KernelOwnerOptions} from '../sandbox/kernel-limits'
import type {ProjectInstallOptions,ProjectInstallResult} from '../npm/project'
import type {NetworkEvent,PortEvent} from '../sandbox/virtual-network'
import type {PreviewState} from '../sandbox/preview'

export const HOST_PROTOCOL_VERSION=1 as const
export const HOST_ATTACH_TYPE='browser-sandbox-host:attach' as const

export interface HostAttachMessage {
  type:typeof HOST_ATTACH_TYPE
  protocolVersion:typeof HOST_PROTOCOL_VERSION
  nonce:string
  ownerOrigin:string
}

export interface HostCapabilities {
  protocolVersion:typeof HOST_PROTOCOL_VERSION
  buildId:string
  apiVersion:number
  crossOriginIsolated:boolean
  sharedArrayBuffer:boolean
  indexedDB:boolean
  operations:readonly HostOperation[]
}

export type HostOperation=
  |'kernel.create'|'kernel.snapshot'|'kernel.restore'|'kernel.readFile'|'kernel.writeFile'
  |'kernel.install'|'kernel.resources'|'kernel.execute'|'kernel.run'|'kernel.runModule'
  |'kernel.saveCheckpoint'|'kernel.restoreCheckpoint'|'kernel.checkpointMetadata'|'kernel.deleteCheckpoint'
  |'kernel.spawn'|'kernel.spawnShell'|'kernel.connect'|'kernel.openFileSession'|'kernel.mountPreview'|'kernel.closePreview'|'kernel.close'
  |'preview.inspect'|'preview.click'
  |'process.next'|'process.write'|'process.end'|'process.wait'|'process.kill'|'process.dispose'
  |'socket.read'|'socket.write'|'socket.end'|'socket.close'
  |'file.call'|'file.close'

export interface HostError {name:string;message:string;code?:string}
export type HostRequest={type:'request';id:number;operation:HostOperation;args:unknown[]}
export type HostCancel={type:'cancel';requestId:number}
export type HostClientMessage=HostRequest|HostCancel
export type HostServerMessage=
  |{type:'attached';protocolVersion:typeof HOST_PROTOCOL_VERSION;nonce:string;capabilities:HostCapabilities}
  |{type:'result';id:number;value:unknown}
  |{type:'error';id:number;error:HostError}
  |{type:'output';requestId:number;level:string;text:string}
  |{type:'port';event:PortEvent}
  |{type:'closed';reason?:HostError}

export interface HostOperationMap {
  'kernel.create':{args:[Record<string,string|Uint8Array>,KernelOwnerOptions];result:void}
  'kernel.snapshot':{args:[];result:WorkspaceSnapshot}
  'kernel.restore':{args:[WorkspaceSnapshot];result:void}
  'kernel.readFile':{args:[string,'utf8'?];result:Uint8Array|string}
  'kernel.writeFile':{args:[string,Uint8Array];result:void}
  'kernel.install':{args:[ProjectInstallOptions];result:ProjectInstallResult}
  'kernel.resources':{args:[];result:KernelResourceSnapshot}
  'kernel.execute':{args:[string,Omit<KernelOptions,'onOutput'>];result:KernelExecutionResult}
  'kernel.run':{args:[string,Omit<KernelOptions,'onOutput'>];result:KernelExecutionResult}
  'kernel.runModule':{args:[string,Omit<KernelOptions,'onOutput'>];result:KernelExecutionResult}
  'kernel.saveCheckpoint':{args:[string];result:CheckpointMetadata}
  'kernel.restoreCheckpoint':{args:[string];result:CheckpointMetadata}
  'kernel.checkpointMetadata':{args:[string];result:CheckpointMetadata|undefined}
  'kernel.deleteCheckpoint':{args:[string];result:boolean}
  'kernel.spawn':{args:[string,string[],SpawnOptions];result:{handle:number;pid:number}}
  'kernel.spawnShell':{args:[string,SpawnOptions];result:{handle:number;pid:number}}
  'kernel.connect':{args:[number,string];result:{handle:number;port:number;remotePort:number}}
  'kernel.openFileSession':{args:[boolean];result:{handle:number}}
  'kernel.mountPreview':{args:[{origin:string;port:number;path?:string;requestTimeoutMs?:number;startupTimeoutMs?:number}];result:void}
  'kernel.closePreview':{args:[];result:void}
  'preview.inspect':{args:[];result:PreviewState&{url:string}}
  'preview.click':{args:[string];result:PreviewState&{url:string}}
  'kernel.close':{args:[];result:void}
  'process.next':{args:[number];result:ProcessEvent|null}
  'process.write':{args:[number,Uint8Array];result:void}
  'process.end':{args:[number];result:void}
  'process.wait':{args:[number];result:KernelProcessResult}
  'process.kill':{args:[number,string];result:boolean}
  'process.dispose':{args:[number];result:void}
  'socket.read':{args:[number];result:NetworkEvent|null}
  'socket.write':{args:[number,Uint8Array];result:void}
  'socket.end':{args:[number];result:void}
  'socket.close':{args:[number];result:void}
  'file.call':{args:[number,string,unknown[]];result:unknown}
  'file.close':{args:[number];result:void}
}

export function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)}
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>key in value)
const id=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0
const error=(value:unknown):value is HostError=>isRecord(value)&&(exact(value,['name','message'])||exact(value,['name','message','code']))&&typeof value.name==='string'&&typeof value.message==='string'&&(value.code===undefined||typeof value.code==='string')
const operation=(value:unknown):value is HostOperation=>typeof value==='string'&&(HOST_OPERATIONS as readonly string[]).includes(value)

export const HOST_OPERATIONS=Object.freeze([
  'kernel.create','kernel.snapshot','kernel.restore','kernel.readFile','kernel.writeFile','kernel.install','kernel.resources','kernel.execute','kernel.run','kernel.runModule',
  'kernel.saveCheckpoint','kernel.restoreCheckpoint','kernel.checkpointMetadata','kernel.deleteCheckpoint','kernel.spawn','kernel.spawnShell','kernel.connect','kernel.openFileSession','kernel.mountPreview','kernel.closePreview','kernel.close','preview.inspect','preview.click',
  'process.next','process.write','process.end','process.wait','process.kill','process.dispose','socket.read','socket.write','socket.end','socket.close','file.call','file.close',
] as const satisfies readonly HostOperation[])

export function parseHostAttachMessage(value:unknown):HostAttachMessage{
  if(!isRecord(value)||!exact(value,['type','protocolVersion','nonce','ownerOrigin'])||value.type!==HOST_ATTACH_TYPE||value.protocolVersion!==HOST_PROTOCOL_VERSION||typeof value.nonce!=='string'||!value.nonce||typeof value.ownerOrigin!=='string')throw Error('Invalid browser sandbox host attachment')
  return value as unknown as HostAttachMessage
}

export function parseHostClientMessage(value:unknown):HostClientMessage{
  if(!isRecord(value)||typeof value.type!=='string')throw Error('Invalid browser sandbox client message')
  if(value.type==='request'&&exact(value,['type','id','operation','args'])&&id(value.id)&&operation(value.operation)&&Array.isArray(value.args))return value as unknown as HostRequest
  if(value.type==='cancel'&&exact(value,['type','requestId'])&&id(value.requestId))return value as unknown as HostCancel
  throw Error('Invalid browser sandbox client message')
}

export function parseHostServerMessage(value:unknown):HostServerMessage{
  if(!isRecord(value)||typeof value.type!=='string')throw Error('Invalid browser sandbox host message')
  if(value.type==='attached'&&exact(value,['type','protocolVersion','nonce','capabilities'])&&value.protocolVersion===HOST_PROTOCOL_VERSION&&typeof value.nonce==='string'&&isRecord(value.capabilities)){
    const capabilities=value.capabilities
    if(exact(capabilities,['protocolVersion','buildId','apiVersion','crossOriginIsolated','sharedArrayBuffer','indexedDB','operations'])&&capabilities.protocolVersion===HOST_PROTOCOL_VERSION&&typeof capabilities.buildId==='string'&&Number.isSafeInteger(capabilities.apiVersion)&&typeof capabilities.crossOriginIsolated==='boolean'&&typeof capabilities.sharedArrayBuffer==='boolean'&&typeof capabilities.indexedDB==='boolean'&&Array.isArray(capabilities.operations)&&capabilities.operations.every(operation))return value as unknown as HostServerMessage
  }
  if(value.type==='result'&&exact(value,['type','id','value'])&&id(value.id))return value as unknown as HostServerMessage
  if(value.type==='error'&&exact(value,['type','id','error'])&&id(value.id)&&error(value.error))return value as unknown as HostServerMessage
  if(value.type==='output'&&exact(value,['type','requestId','level','text'])&&id(value.requestId)&&typeof value.level==='string'&&typeof value.text==='string')return value as unknown as HostServerMessage
  if(value.type==='port'&&exact(value,['type','event'])&&isRecord(value.event)&&(value.event.type==='open'||value.event.type==='close')&&Number.isSafeInteger(value.event.port)&&Number(value.event.port)>0&&Number(value.event.port)<=65535)return value as unknown as HostServerMessage
  if(value.type==='closed'&&(exact(value,['type'])||exact(value,['type','reason']))&&(value.reason===undefined||error(value.reason)))return value as unknown as HostServerMessage
  throw Error('Invalid browser sandbox host message')
}

export function hostError(value:unknown):HostError{
  const cause=value as {name?:unknown;message?:unknown;code?:unknown}
  return {name:typeof cause?.name==='string'?cause.name:'Error',message:typeof cause?.message==='string'?cause.message:String(value),...(typeof cause?.code==='string'?{code:cause.code}:{})}
}
