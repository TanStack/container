import type {AgentSessionBackend,AgentProcessHandle} from '../sdk/agent-session-core'
import type {NativeOwnerClient} from './owner-transport'
import type {ProjectInstallOptions} from '../npm/project'
import type {WorkspaceSnapshot} from '../sandbox/files'
import type {SpawnOptions} from '../sandbox/guest-processes'
import {NativeAgentFileSession} from './agent-file-session'
import {spawnNativeAgentProcess} from './agent-process'
import {installNativeAgentProject} from './agent-install'

/** Owns an already-started native owner client and its agent capabilities. */
export class NativeAgentBackend implements AgentSessionBackend {
  #closed=false
  #files=new Set<NativeAgentFileSession>()
  #processes=new Set<AgentProcessHandle>()
  #operations=new Set<Promise<unknown>>()
  #replacement=false
  #installController:AbortController|undefined
  shutdown:Promise<void>|undefined
  constructor(readonly owner:NativeOwnerClient,readonly workspaceRoot='/app'){
    if(!/^\/[A-Za-z0-9._-]+$/.test(workspaceRoot)||workspaceRoot==='/.'||workspaceRoot==='/..')throw Error('Invalid native agent workspace root')
  }
  #check(){if(this.#closed)throw Error('Native agent backend closed')}
  #available(){this.#check();if(this.#replacement)throw Error('Native workspace replacement is pending')}
  #track<T>(operation:Promise<T>):Promise<T>{
    this.#operations.add(operation)
    void operation.then(()=>this.#operations.delete(operation),()=>this.#operations.delete(operation))
    return operation
  }
  async openFileSession({writable=false}={}){
    this.#check()
    const session=new NativeAgentFileSession(this.owner,writable)
    this.#files.add(session)
    return {call:async(method:string,args:unknown[])=>{this.#available();return this.#track(session.call(method,args))},close:async()=>{this.#files.delete(session);await session.close()}}
  }
  async readFile(path:string){this.#available();return this.#track(this.owner.readFile(path))}
  async writeFile(path:string,bytes:Uint8Array){this.#available();await this.#track(this.owner.writeFile(path,bytes))}
  async install(options:ProjectInstallOptions={},signal?:AbortSignal){
    this.#available()
    if(options.ignoreScripts===false)throw Object.assign(Error('Native installs do not execute lifecycle scripts'),{code:'ERR_UNSUPPORTED_OPERATION'})
    if(Object.keys(options).some(key=>!['cwd','ignoreScripts'].includes(key)))throw Error('Unsupported native install option')
    if(options.cwd!==undefined&&options.cwd!==this.workspaceRoot)throw Error('Native installs require the mounted workspace root')
    if(this.#processes.size||this.#operations.size)throw Error('Stop active agent operations before installing')
    const controller=new AbortController(),abort=()=>controller.abort(signal?.reason)
    signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true})
    this.#replacement=true;this.#installController=controller
    try{return await this.#track(installNativeAgentProject(this.owner,this.workspaceRoot,{signal:controller.signal}))}
    finally{this.#replacement=false;this.#installController=undefined;signal?.removeEventListener('abort',abort)}
  }
  async spawn(command:string,args:string[]=[],options:SpawnOptions={}){
    this.#available()
    if(Object.keys(options).some(key=>!['cwd','env','stdio'].includes(key)&&options[key as keyof SpawnOptions]!==undefined)||
      options.stdio!==undefined&&options.stdio!=='pipe')throw Object.assign(Error('Unsupported native agent spawn option'),{code:'ERR_UNSUPPORTED_OPERATION'})
    const process=spawnNativeAgentProcess(this.owner,{command,args,cwd:options.cwd??this.workspaceRoot,env:options.env},
      options.stdio==='pipe'?{stdin:'pipe'}:{})
    this.#processes.add(process)
    const dispose=process.dispose
    process.dispose=async()=>{try{await dispose()}finally{this.#processes.delete(process)}}
    return process
  }
  async snapshot(){this.#available();return this.#track(this.owner.snapshotWorkspace())}
  async restore(snapshot:WorkspaceSnapshot){
    this.#available()
    if(snapshot.version!==5)throw Error('Native agent restore requires a version 5 workspace snapshot')
    if(this.#processes.size)throw Error('Dispose active agent process handles before restoring')
    if(this.#operations.size)throw Error('Finish active agent operations before restoring')
    this.#replacement=true
    try{await this.#track(this.owner.restoreWorkspace(snapshot))}finally{this.#replacement=false}
  }
  async resources(){this.#check();return this.#track(this.owner.resources())}
  close(){
    if(this.#closed)return
    this.#closed=true
    this.#installController?.abort()
    this.shutdown=(async()=>{
      const outcomes=await Promise.allSettled([...this.#files].map(session=>session.close()).concat([...this.#processes].map(process=>process.dispose())))
      await Promise.allSettled([...this.#operations])
      this.#files.clear();this.#processes.clear()
      try{await this.owner.dispose()}finally{this.owner.close()}
      const errors=outcomes.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason)
      if(errors.length)throw new AggregateError(errors,'Native agent cleanup failed')
    })()
    void this.shutdown.catch(()=>{})
  }
}
