import type {NativeFileOperations} from './filesystem-operations'
import {runMvdanWorkerWithFactory} from '../sandbox/mvdan-worker-core'
import {NativeTerminalFileSession} from './terminal-file-session'
import {NativeTerminalProcesses} from './terminal-processes'
import type {NativeCommandWorkerFactory} from './terminal-processes'
import {NativeTerminalInput} from './terminal-input'
import type {NativeTerminalResult} from './terminal-types'
import {toShellDirectory,fromShellDirectory} from './terminal-paths'

/** Execute shell syntax in a disposable worker against the live native volume. */
export async function runNativeTerminalShell(volume:NativeFileOperations,line:string,cwd:string,assetBaseURL:string,createWorker:()=>Worker,
  createCommandWorker?:NativeCommandWorkerFactory,
  onOutput?:(stream:'stdout'|'stderr',text:string)=>void,signal?:AbortSignal,inputPort?:MessagePort,shellState?:string,
  size?:{columns:number;rows:number},env:Record<string,string>={},
  installPackages?:(signal:AbortSignal,onProgress:(text:string)=>void)=>Promise<void>):Promise<NativeTerminalResult>{
  if(typeof line!=='string'||line.length>8192){inputPort?.close();throw Error('Terminal command exceeds limit')}
  let shellCwd:string
  try{shellCwd=toShellDirectory(cwd)}catch(error){inputPort?.close();throw error}
  if(size!==undefined&&(!Number.isSafeInteger(size?.columns)||size.columns<1||size.columns>1000||
    !Number.isSafeInteger(size?.rows)||size.rows<1||size.rows>1000)){
    inputPort?.close();throw Error('Invalid terminal size')
  }
  const files=new NativeTerminalFileSession(volume)
  const processes=new NativeTerminalProcesses(volume,files,createCommandWorker,createWorker,assetBaseURL,installPackages)
  if(size)processes.resize(size.columns,size.rows)
  const input=new NativeTerminalInput(inputPort,(columns,rows)=>processes.resize(columns,rows))
  const out=new TextDecoder(),err=new TextDecoder()
  let stdout='',stderr=''
  try{
    const result=await runMvdanWorkerWithFactory({
      assetBaseURL,script:line,timeoutMs:30000,lifetime:'session',cwd:shellCwd,env,shellState,signal,
      call:async(method,args)=>{
        if(method.startsWith('process.'))return processes.call(method,args)
        return files.call(method,args)
      },
      readStdin:()=>input.read(),
      writeStdout:async bytes=>{
        const text=out.decode(bytes,{stream:true})
        if(onOutput)onOutput('stdout',text)
        else stdout+=text
      },
      writeStderr:async bytes=>{
        const text=err.decode(bytes,{stream:true})
        if(onOutput)onOutput('stderr',text)
        else stderr+=text
      },
    },createWorker)
    const finalOut=out.decode(),finalErr=err.decode()
    if(onOutput){if(finalOut)onOutput('stdout',finalOut);if(finalErr)onOutput('stderr',finalErr)}
    else{stdout+=finalOut;stderr+=finalErr}
    const finalCwd=result.cwd??shellCwd
    return {cwd:fromShellDirectory(finalCwd),stdout,stderr,exitCode:result.code,changedPaths:files.workspaceChangedPaths,shellState:result.shellState}
  }finally{input.close();processes.close();files.close()}
}
