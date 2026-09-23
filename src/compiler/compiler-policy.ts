/** Owner opt-in for the pinned compiler, not a guest execution option.
 * In bounded mode the timeout covers the whole workflow. Session mode bounds
 * individual protocol requests, including plugin callbacks, but permits idle time. The memory
 * cap bounds WASM linear memory only, not browser JavaScript heap.
 */
export interface ExperimentalCompilerPolicy {maxMemoryPages:number;timeoutMs:number;lifetime?:'bounded'|'session'}
export function compilerPolicy(value:unknown):Readonly<ExperimentalCompilerPolicy>|undefined{
  if(value===undefined)return undefined
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid experimental compiler policy')
  const {maxMemoryPages,timeoutMs,lifetime='bounded'}=value as ExperimentalCompilerPolicy
  if(!Number.isSafeInteger(maxMemoryPages)||maxMemoryPages<95||maxMemoryPages>8192||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>120000)throw Error('Invalid experimental compiler policy')
  if(lifetime!=='bounded'&&lifetime!=='session')throw Error('Invalid experimental compiler lifetime')
  return Object.freeze({maxMemoryPages,timeoutMs,lifetime})
}
