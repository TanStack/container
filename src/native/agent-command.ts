import type {NativeOwnerClient} from './owner-transport'
import {NativeTerminalCapture} from './terminal-capture'
import type {NativeTerminalOutput} from './terminal-types'

export type NativeAgentCommandBackend=Pick<NativeOwnerClient,'terminalCommand'>&Partial<Pick<NativeOwnerClient,'openTerminalCommand'>>
export type NativeAgentInput=Pick<ReturnType<NativeOwnerClient['openTerminalCommand']>,'writeInput'|'endInput'>&
  Partial<Pick<ReturnType<NativeOwnerClient['openTerminalCommand']>,'writeInputAcknowledged'>>
export interface NativeAgentCommandOptions {signal?:AbortSignal;maxOutputBytes?:number;onOutput?:NativeTerminalOutput;onInput?:(input:NativeAgentInput)=>void}
/** Run a literal command and argument vector through the existing native shell. */
export async function runNativeAgentCommand(backend:NativeAgentCommandBackend,
  input:{command:string;args?:string[];cwd:string;env?:Record<string,string>},options:NativeAgentCommandOptions={}){
  options.signal?.throwIfAborted()
  if(input.args!==undefined&&!Array.isArray(input.args))throw Error('Native agent arguments must be an array')
  const values=[input.command,...(input.args??[])]
  if(typeof input.command!=='string'||!input.command||values.some(value=>typeof value!=='string'||value.includes('\0')))throw Error('Invalid native agent command or arguments')
  if(typeof input.cwd!=='string'||!input.cwd.startsWith('/')||input.cwd.includes('\0')||input.cwd.includes('\\')||input.cwd.split('/').some(part=>part==='..'))throw Error('Invalid native agent command directory')
  const quote=(value:string)=>"'"+value.replaceAll("'",`'"'"'`)+"'"
  if(input.env!==undefined&&(!input.env||typeof input.env!=='object'||Array.isArray(input.env)))throw Error('Invalid native command environment')
  const environment=Object.entries(input.env??{}).map(([name,value])=>{
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||typeof value!=='string'||value.includes('\0'))throw Error('Invalid native environment name or value')
    return name+'='+quote(value)
  })
  const line=[...environment,...values.map(quote)].join(' ')
  if(line.length>8192)throw Error('Native agent command exceeds terminal command length')
  const capture=new NativeTerminalCapture(options.maxOutputBytes)
  let active=true
  try {
  const output:NativeTerminalOutput=(text,stream)=>{
    if(!active||options.signal?.aborted)return
    capture.write(text,stream)
    options.onOutput?.(text,stream)
  }
  let result
  if(options.onInput){
    if(!backend.openTerminalCommand)throw Object.assign(Error('Native agent stdin is unavailable'),{code:'ERR_UNSUPPORTED_OPERATION'})
    const command=backend.openTerminalCommand(line,input.cwd,output)
    const abort=()=>command.interrupt()
    options.signal?.addEventListener('abort',abort,{once:true})
    try{
      if(options.signal?.aborted)abort()
      options.onInput(command)
      result=await command.result
    }catch(error){
      active=false
      command.interrupt()
      // Keep the handle owned until the worker acknowledges interruption.
      try{await command.result}catch{}
      throw error
    }
    finally{options.signal?.removeEventListener('abort',abort)}
  }else result=await backend.terminalCommand(line,input.cwd,output,options.signal)
  options.signal?.throwIfAborted()
  return {...capture.finish(),status:result.exitCode,cwd:result.cwd,changedPaths:result.changedPaths}
  } finally {active=false}
}
