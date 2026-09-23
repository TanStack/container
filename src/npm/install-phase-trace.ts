type InstallPhase = 'install-planning' | 'workspace-staging' | 'tar-extraction' | 'workspace-commit' | 'package-file-write'
type InstallPhaseState = 'begin' | 'end' | 'error'
declare global {
  var __sandboxInstallPhaseTrace: ((stage: InstallPhase, state: InstallPhaseState, traceId?: number) => number | undefined) | undefined
}
let events = 0
const noop = (_state: 'end' | 'error') => {}
// Installed only by the explicit diagnostic worker prefix. Never report data.
export function startInstallPhase(stage: InstallPhase): (state: 'end' | 'error') => void {
  const sink = globalThis.__sandboxInstallPhaseTrace
  if (typeof sink !== 'function' || events >= 2048) return noop
  const send = (state: InstallPhaseState, traceId?: number) => {
    if (events >= 2048) return
    events++
    try { return sink(stage, state, traceId) } catch { /* Observation must not alter installation. */ }
  }
  const traceId=send('begin')
  let finished=false
  return state=>{
    if(finished)return
    finished=true
    send(state,traceId)
  }
}
export function traceInstallPhase<T>(stage: InstallPhase, operation: () => T): T {
  const finish=startInstallPhase(stage)
  try {
    const result = operation()
    finish('end')
    return result
  } catch (error) {
    finish('error')
    throw error
  }
}
