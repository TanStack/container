/** Host-owned ceilings for one guest execution, not total worker/process memory. */
export interface KernelLimits {maxBytes:number;timeoutMs:number}
/** Host-selected worker allocation ceiling. Ordinary child processes are unchanged. */
export interface KernelWorkerPolicy {workerMaxBytes?:number;/** Owner-only opt-in to the pinned browser compiler. Disabled by default. */experimentalCompiler?:import('../compiler/compiler-policy').ExperimentalCompilerPolicy;/** Separate native compiler reservations, outside guest memory limits. Disabled by default. */experimentalRolldownParser?:import('../compiler/rolldown-parser-policy').RolldownParserPolicy}
export interface KernelWorkspaceLimits {maxBytes:number;maxFiles:number}
export interface KernelSharedMemoryPerEngineLimits {maxBytes:number;/** Reserve growth capacity within the same byte ceiling. Disabled by default. */growthReservation:boolean}
export interface KernelOwnerOptions extends Partial<KernelLimits>,KernelWorkerPolicy {workspace?:Partial<KernelWorkspaceLimits>;cooperative?:boolean;assetBaseURL?:string;/** Experimental fiber candidate, requires the experimental-fibers SDK profile or separately built lab assets. */experimentalFibers?:boolean;/** Shared storage ceiling per engine, not a whole-kernel or per-process memory limit. Requires experimentalFibers. */sharedMemoryPerEngine?:Partial<KernelSharedMemoryPerEngineLimits>}
const defaultLimits:KernelLimits={maxBytes:64*1024*1024,timeoutMs:30000}
const supportedLimits:KernelLimits={maxBytes:512*1024*1024,timeoutMs:120000}

function bounded(value:unknown,min:number,max:number):value is number{
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max
}
export function workerMemoryLimit(owner:Readonly<KernelLimits>,value:unknown):number|undefined{
  if(value===undefined)return undefined
  if(!bounded(value,256*1024,owner.maxBytes))throw Error('Invalid worker memory limit')
  return value
}
/** A worker cannot regain memory that its parent was not approved to allocate. */
export function workerExecutionLimits(parent:Readonly<KernelLimits>,workerMaxBytes?:number):KernelLimits{
  return childExecutionLimits(parent,{maxBytes:workerMaxBytes===undefined?parent.maxBytes:Math.min(parent.maxBytes,workerMaxBytes)})
}
export function sharedMemoryPerEngineLimits(value:Partial<KernelSharedMemoryPerEngineLimits>|undefined=undefined,experimentalFibers=false):Readonly<KernelSharedMemoryPerEngineLimits>{
  if(value!==undefined&&experimentalFibers!==true)throw Error('Shared memory per engine requires experimental fibers')
  if(value!==undefined&&(!value||typeof value!=='object'||Array.isArray(value)))throw Error('Invalid shared memory per engine limits')
  const maxBytes=value?.maxBytes===undefined?16*1024*1024:value.maxBytes
  if(!bounded(maxBytes,65536,1536*1024*1024))throw Error('Invalid shared memory per engine limits')
  const growthReservation=value?.growthReservation===undefined?false:value.growthReservation
  if(typeof growthReservation!=='boolean')throw Error('Invalid shared memory growth reservation')
  return Object.freeze({maxBytes,growthReservation})
}
export function kernelLimits(value:Partial<KernelLimits>={}):Readonly<KernelLimits>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid kernel limits')
  const limits={maxBytes:value.maxBytes??defaultLimits.maxBytes,timeoutMs:value.timeoutMs??defaultLimits.timeoutMs}
  if(!bounded(limits.maxBytes,256*1024,supportedLimits.maxBytes)||!bounded(limits.timeoutMs,10,supportedLimits.timeoutMs))throw Error('Invalid kernel limits')
  return Object.freeze(limits)
}
export function workspaceLimits(value:Partial<KernelWorkspaceLimits>={}):Readonly<KernelWorkspaceLimits>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid workspace limits')
  const limits={maxBytes:value.maxBytes??32*1024*1024,maxFiles:value.maxFiles??16384}
  if(!bounded(limits.maxBytes,0,512*1024*1024)||!bounded(limits.maxFiles,1,131072))throw Error('Invalid workspace limits')
  return Object.freeze(limits)
}
export function executionLimits(ceiling:Readonly<KernelLimits>,value:Partial<KernelLimits>={}):KernelLimits{
  const limits={maxBytes:value.maxBytes??Math.min(16*1024*1024,ceiling.maxBytes),timeoutMs:value.timeoutMs??Math.min(5000,ceiling.timeoutMs)}
  if(!bounded(limits.maxBytes,256*1024,ceiling.maxBytes)||!bounded(limits.timeoutMs,10,ceiling.timeoutMs))throw Error('Invalid execution limits')
  return limits
}

/** Children inherit the approved execution policy, not the root command defaults. */
export function childExecutionLimits(parent:Readonly<KernelLimits>,value:Partial<KernelLimits>={}):KernelLimits{
  return executionLimits(parent,{maxBytes:value.maxBytes??parent.maxBytes,timeoutMs:value.timeoutMs??parent.timeoutMs})
}
