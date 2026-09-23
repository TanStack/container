export interface RolldownProbeResources {created:number;peak:number;active:number;sharedInitialBytes:number;sharedMaximumBytes:number}
export interface RolldownProbeChunk {code:string;filename:string}
export interface RolldownProbeCompile {chunks:RolldownProbeChunk[];resources:RolldownProbeResources}
export interface RolldownProbeParseOptions {lang?:'js'|'jsx'|'ts'|'tsx';sourceType?:'script'|'module'|'commonjs'|'unambiguous';preserveParens?:boolean}
/** Raw binding representation. Rolldown's guest wrapper restores AST values. */
export interface RolldownProbeParseResult {program:string;module:unknown;comments:unknown[];errors:unknown[]}
export interface RolldownProbeOptions {
  createWorker():Worker
  files:Record<string,string>
  callback(method:string,args:unknown[]):Promise<unknown>
  timeoutMs?:number
}
type Command={command:'compile'}|{command:'parse';filename:string;source:string;options?:RolldownProbeParseOptions}|{command:'writeFile';path:string;source:string}|{command:'close'}
type Reply={type:'ready';resources:RolldownProbeResources}|{type:'error';error:string}|{type:'result';id:number;value?:unknown;error?:string}|{type:'callback';id:number;method:string;args:unknown[]}

/** Isolated finite compiler session. No guest code is evaluated in this owner. */
export class RolldownProbeSession {
  #worker:Worker
  #sequence=0
  #closed=false
  #queue=Promise.resolve()
  #pending=new Map<number,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>()
  #timeout:number
  #ready:Promise<void>
  #closing:Promise<RolldownProbeResources>|undefined
  private constructor(private options:RolldownProbeOptions){
    this.#timeout=options.timeoutMs??30000
    if(!Number.isInteger(this.#timeout)||this.#timeout<1||this.#timeout>30000)throw Error('Invalid compiler deadline')
    if(!globalThis.crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw Error('Native Rolldown requires COI and SAB')
    this.#worker=options.createWorker()
    this.#ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{const error=Error('Compiler startup deadline exceeded');reject(error);this.#stop(error)},this.#timeout)
      this.#worker.onerror=event=>{clearTimeout(timer);const error=Error(event.message||'Compiler worker failed');reject(error);this.#stop(error)}
      this.#worker.onmessage=({data}:{data:Reply})=>{
        if(this.#closed)return
        if(data.type==='ready'){clearTimeout(timer);resolve();return}
        if(data.type==='error'){clearTimeout(timer);const error=Error(data.error);reject(error);this.#stop(error);return}
        if(data.type==='result'){
          const pending=this.#pending.get(data.id);if(!pending)return
          clearTimeout(pending.timer);this.#pending.delete(data.id)
          data.error?pending.reject(Error(data.error)):pending.resolve(data.value);return
        }
        if(data.type==='callback'){
          void Promise.resolve().then(()=>options.callback(data.method,data.args)).then(value=>{if(!this.#closed)this.#worker.postMessage({type:'reply',id:data.id,value})},error=>{if(!this.#closed)this.#worker.postMessage({type:'reply',id:data.id,error:String(error)})});return
        }
        this.#stop(Error('Unsupported compiler reply'))
      }
      this.#worker.postMessage({type:'start',files:options.files})
    })
  }
  static async open(options:RolldownProbeOptions){const session=new RolldownProbeSession(options);await session.#ready;return session}
  #stop(error:Error){
    if(this.#closed)return
    this.#closed=true
    this.#worker.postMessage({type:'abort'});this.#worker.terminate()
    for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(error)}
    this.#pending.clear()
  }
  #request(command:Command):Promise<any>{
    if(this.#closed||this.#closing)return Promise.reject(Error('Compiler session is closed'))
    const result=this.#queue.then(()=>new Promise((resolve,reject)=>{
      if(this.#closed){reject(Error('Compiler session is closed'));return}
      const id=++this.#sequence
      const timer=setTimeout(()=>this.#stop(Error('Compiler request deadline exceeded')),this.#timeout)
      this.#pending.set(id,{resolve,reject,timer});this.#worker.postMessage({type:'command',id,...command})
    }))
    this.#queue=result.then(()=>{},()=>{})
    return result
  }
  compile():Promise<RolldownProbeCompile>{return this.#request({command:'compile'})}
  parse(filename:string,source:string,options?:RolldownProbeParseOptions):Promise<RolldownProbeParseResult>{return this.#request({command:'parse',filename,source,options})}
  async writeFile(path:string,source:string):Promise<void>{await this.#request({command:'writeFile',path,source})}
  close():Promise<RolldownProbeResources>{
    if(this.#closing)return this.#closing
    this.#closing=this.#request({command:'close'}).then(result=>{this.#stop(Error('Compiler session closed'));return result.resources})
    return this.#closing
  }
}
