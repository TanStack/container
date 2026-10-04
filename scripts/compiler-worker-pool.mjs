import assert from 'node:assert/strict'

// A single worker can strand callable compiler work after its JS callback returns.
// Keep four workers, matching the pinned binding's async-work default.
export function browserCompilerWorkerPool(env=process.env){
  const requested=env.BROWSER_ROLLDOWN_WORKER_POOL_CONTROL
  assert(requested===undefined||requested==='1'||requested==='4','Worker-pool control must be 1, 4 or unset')
  return {size:requested===undefined?4:Number(requested),diagnostic:requested!==undefined}
}
