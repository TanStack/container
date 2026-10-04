import type {NativeFileOperations} from './filesystem-operations'
import {NativeTerminalFileSession} from './terminal-file-session'
import {NativeTerminalProcesses} from './terminal-processes'
import type {NativeCommandWorkerFactory} from './terminal-processes'
import {NativeTerminalInput} from './terminal-input'
import type {NativeTerminalResult} from './terminal-types'
import {toShellDirectory,fromShellDirectory} from './terminal-paths'

type CurrentCommand={
  resolve:(result:NativeTerminalResult)=>void
  reject:(error:Error)=>void
  output?:(stream:'stdout'|'stderr',text:string)=>void
  input:NativeTerminalInput
  stdout:string
  stderr:string
  out:TextDecoder
  err:TextDecoder
  signal?:AbortSignal
  abort:()=>void
}

/** One interactive shell runner with the live workspace and process channels. */
export class NativeTerminalSession {
  readonly ready:Promise<void>
  #worker:Worker
  #files:NativeTerminalFileSession
  #processes:NativeTerminalProcesses
  #current?:CurrentCommand
  #closed=false
  #cwd:string
  #readyResolve!:()=>void
  #readyReject!:(error:Error)=>void
  #readySettled=false
  #env:Record<string,string>

  constructor(volume:NativeFileOperations,cwd:string,assetBaseURL:string,createWorker:()=>Worker,
    createCommandWorker?:NativeCommandWorkerFactory,
    installPackages?:(signal:AbortSignal,onProgress:(text:string)=>void)=>Promise<void>,env:Record<string,string>={}){
    toShellDirectory(cwd)
    this.#cwd=cwd
    this.#env={...env}
    this.#files=new NativeTerminalFileSession(volume)
    this.#processes=new NativeTerminalProcesses(volume,this.#files,createCommandWorker,createWorker,assetBaseURL,installPackages)
    this.#worker=createWorker()
    this.ready=new Promise<void>((resolve,reject)=>{this.#readyResolve=resolve;this.#readyReject=reject})
    this.#worker.onerror=event=>this.#fail(Error(event.error instanceof Error?event.error.stack??event.error.message:event.message||'Shell worker failed'))
    this.#worker.onmessageerror=()=>this.#fail(Error('Shell worker message could not be decoded'))
    this.#worker.onmessage=({data})=>{void this.#message(data)}
    this.#worker.postMessage({init:true,assetBaseURL})
  }

  async #message(data:any){
    if(this.#closed)return
    if(data.ready){this.#readySettled=true;this.#readyResolve();return}
    if(data.error){this.#fail(Error(data.error));return}
    if(data.result){
      const command=this.#current
      if(!command){this.#fail(Error('Unexpected shell result'));return}
      const result=data.result as {code:number;cwd?:string}
      let finalCwd:string
      try{finalCwd=fromShellDirectory(result.cwd??toShellDirectory(this.#cwd))}
      catch(error){this.#fail(error as Error);return}
      const finalOut=command.out.decode(),finalErr=command.err.decode()
      if(command.output){if(finalOut)command.output('stdout',finalOut);if(finalErr)command.output('stderr',finalErr)}
      else{command.stdout+=finalOut;command.stderr+=finalErr}
      this.#cwd=finalCwd
      this.#current=undefined
      command.signal?.removeEventListener('abort',command.abort)
      command.input.close()
      command.resolve({cwd:this.#cwd,stdout:command.stdout,stderr:command.stderr,exitCode:command.signal?.aborted?130:result.code,
        changedPaths:this.#files.workspaceChangedPaths})
      return
    }
    const command=this.#current
    if(!command||!Number.isSafeInteger(data.id)||typeof data.method!=='string'||!Array.isArray(data.args)){
      this.#fail(Error('Invalid shell transport request'));return
    }
    try{
      let value:unknown
      if(data.method==='stdio.read')value=await command.input.read()
      else if(data.method==='stdio.stdout'||data.method==='stdio.stderr'){
        const bytes=data.args[0]
        if(!(bytes instanceof Uint8Array)||bytes.byteLength>65536)throw Error('Invalid shell output chunk')
        const stream=data.method==='stdio.stdout'?'stdout':'stderr'
        const text=(stream==='stdout'?command.out:command.err).decode(bytes,{stream:true})
        if(command.output)command.output(stream,text)
        else command[stream]+=text
      }else value=await (data.method.startsWith('process.')?this.#processes:this.#files).call(data.method,data.args)
      if(!this.#closed)this.#worker.postMessage({reply:data.id,value})
    }catch(error){
      const code=error&&typeof error==='object'&&'code' in error?String(error.code):undefined
      if(!this.#closed)this.#worker.postMessage({reply:data.id,error:String(error),code})
    }
  }

  async run(line:string,onOutput?:(stream:'stdout'|'stderr',text:string)=>void,signal?:AbortSignal,inputPort?:MessagePort,
    size?:{columns:number;rows:number}):Promise<NativeTerminalResult>{
    if(typeof line!=='string'||line.length>8192){inputPort?.close();throw Error('Terminal command exceeds limit')}
    if(this.#closed){inputPort?.close();throw Error('Terminal session closed')}
    if(this.#current){inputPort?.close();throw Error('Terminal command already running')}
    try{await this.ready}catch(error){inputPort?.close();throw error}
    if(this.#current){inputPort?.close();throw Error('Terminal command already running')}
    if(this.#closed){inputPort?.close();throw Error('Terminal session closed')}
    if(signal?.aborted){inputPort?.close();return {cwd:this.#cwd,stdout:'',stderr:'',exitCode:130,changedPaths:[]}}
    if(size){
      if(!Number.isSafeInteger(size.columns)||size.columns<1||size.columns>1000||
        !Number.isSafeInteger(size.rows)||size.rows<1||size.rows>1000){inputPort?.close();throw Error('Invalid terminal size')}
      this.#processes.resize(size.columns,size.rows)
    }
    this.#files.changedPaths.clear()
    const input=new NativeTerminalInput(inputPort,(columns,rows)=>this.#processes.resize(columns,rows))
    return new Promise<NativeTerminalResult>((resolve,reject)=>{
      const abort=()=>{
        input.close()
        try{this.#worker.postMessage({interrupt:true})}
        catch(error){this.#fail(error instanceof Error?error:Error(String(error)))}
      }
      this.#current={resolve,reject,output:onOutput,input,stdout:'',stderr:'',out:new TextDecoder(),err:new TextDecoder(),signal,abort}
      signal?.addEventListener('abort',abort,{once:true})
      try{
        this.#worker.postMessage({run:true,persistent:true,streaming:true,script:line,timeoutMs:0,
          cwd:toShellDirectory(this.#cwd),env:this.#env})
      }catch(error){this.#fail(error instanceof Error?error:Error(String(error)))}
    })
  }

  #fail(error:Error){
    if(this.#closed)return
    if(!this.#readySettled){this.#readySettled=true;this.#readyReject(error)}
    this.#current?.reject(error)
    this.dispose()
  }
  dispose(){
    if(this.#closed)return
    this.#closed=true
    if(!this.#readySettled){this.#readySettled=true;this.#readyReject(Error('Terminal session closed'))}
    this.#current?.signal?.removeEventListener('abort',this.#current.abort)
    this.#current?.input.close()
    this.#current?.reject(Error('Terminal session closed'))
    this.#current=undefined
    this.#worker.terminate()
    this.#processes.close()
    this.#files.close()
  }
}
