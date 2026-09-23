/** Owner opt-in. Limits linear WASM memory, not browser heap. */
export interface RolldownParserPolicy {timeoutMs:number;/** UTF-8 source ceiling per request and for aggregate pending kernel parser inputs. */maxSourceBytes:number}
export const rolldownParserResources=Object.freeze({initialPages:4096,maximumPages:20480,maxWorkers:8,asyncWorkPoolSize:4})
/**
 * The synchronous compiler cannot share the full compiler worker because the
 * caller waits with Atomics.wait. Keep its N-API and Tokio workers separate,
 * but size the instance for the synchronous binding surface only.
 *
 * The pinned WASM imports shared memory with a 1001-page minimum. 1024 pages
 * leaves a small startup margin without reserving another 256 MiB instance.
 */
export const rolldownSynchronousCompilerResources=Object.freeze({initialPages:1024,maximumPages:8192,maxWorkers:2,asyncWorkPoolSize:1})
export type RolldownCompilerProfile='full'|'sync'
export function rolldownCompilerResources(profile:RolldownCompilerProfile){return profile==='sync'?rolldownSynchronousCompilerResources:rolldownParserResources}
export function rolldownParserPolicy(value:unknown):Readonly<RolldownParserPolicy>|undefined{
  if(value===undefined)return undefined
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid native parser policy')
  const {timeoutMs,maxSourceBytes}=value as RolldownParserPolicy
  if(Object.keys(value).some(key=>!['timeoutMs','maxSourceBytes'].includes(key))||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000||!Number.isSafeInteger(maxSourceBytes)||maxSourceBytes<1||maxSourceBytes>16*1024*1024)throw Error('Invalid native parser policy')
  return Object.freeze({timeoutMs,maxSourceBytes})
}
