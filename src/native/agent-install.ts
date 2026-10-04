import type {NativeOwnerClient} from './owner-transport'
import type {NativeTerminalOutput} from './terminal-types'

export type NativeAgentInstallBackend=Pick<NativeOwnerClient,'terminalCommand'|'installResult'>
/** Install the mounted manifest through the owner's transactional install path. */
export async function installNativeAgentProject(backend:NativeAgentInstallBackend,
  cwd:string,options:{signal?:AbortSignal;onOutput?:NativeTerminalOutput}={}){
  options.signal?.throwIfAborted()
  if(typeof cwd!=='string'||!cwd.startsWith('/')||cwd.includes('\0')||cwd.includes('\\')||cwd.split('/').includes('..'))throw Error('Invalid native install directory')
  const result=await backend.terminalCommand('npm install',cwd,options.onOutput,options.signal)
  options.signal?.throwIfAborted()
  if(result.exitCode!==0)throw Object.assign(Error(result.stderr||`Native dependency install exited with ${result.exitCode}`),{code:'ERR_INSTALL_FAILED'})
  const installed=await backend.installResult()
  options.signal?.throwIfAborted()
  return installed
}
