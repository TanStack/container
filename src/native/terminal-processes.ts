import type {NativeFileOperations} from './filesystem-operations'
import path from 'path-browserify'
import {NativeTerminalFileSession} from './terminal-file-session'
import {runMvdanWorkerWithFactory} from '../sandbox/mvdan-worker-core'
import {parseNativeInstallCommand} from './project-script'
import {parseNodeInvocation} from './launch-conditions'

export type NativeCommandWorker={
  on(event:'stdout'|'stderr'|'stdout-bytes'|'stderr-bytes'|'error',listener:(value:any,done?:()=>void)=>void):unknown
  once(event:'exit',listener:(code:number)=>void):unknown
  writeInput(bytes:Uint8Array|null):void|Promise<void>
  terminate():Promise<number|undefined>
  readonly changedPaths:string[]
}
export type NativeCommandWorkerFactory=(entry:string,options:{argv:string[];cwd:string;env:Record<string,string>;evalSource?:string;stdinSource?:boolean;execArgv?:string[]})=>NativeCommandWorker

type ProcessEvent={type:'stdout'|'stderr';bytes:Uint8Array}|{type:'exit';code:number}
type ProgramContext={
  args:string[]
  cwd:string
  env:Record<string,string>
  scriptStack:string[]
  signal:AbortSignal
  input:AsyncIterable<Uint8Array>
  output(stream:'stdout'|'stderr',bytes:Uint8Array):Promise<void>
  files:NativeTerminalFileSession
  volume:NativeFileOperations
  terminalSize:()=>{columns:number;rows:number}
  createCommandWorker?:NativeCommandWorkerFactory
  runShellScript?:(name:string,script:string,cwd:string,env:Record<string,string>,context:ProgramContext)=>Promise<number>
  installPackages?:(signal:AbortSignal,onProgress:(text:string)=>void)=>Promise<void>
}
type Program=(context:ProgramContext)=>Promise<number>

const encoder=new TextEncoder()
const writeText=(context:ProgramContext,stream:'stdout'|'stderr',value:string)=>context.output(stream,encoder.encode(value))
async function packageScript(context:ProgramContext,manager:string){
  const {args,cwd,files,volume,env,runShellScript}=context
  if(['install','i','ci'].includes(args[0]??'')){
    try{parseNativeInstallCommand([manager,...args].join(' '))}
    catch(error){writeText(context,'stderr',`${manager}: ${String(error)}\n`);return 2}
    if(files.resolvePath('.',cwd)!=='/app'){
      writeText(context,'stderr',`${manager}: live installation currently requires the project root\n`)
      return 2
    }
    if(!context.installPackages){writeText(context,'stderr',`${manager}: live installation is unavailable\n`);return 1}
    writeText(context,'stdout','Installing dependencies...\n')
    await context.installPackages(context.signal,text=>writeText(context,'stdout',text))
    files.changedPaths.add('/app/node_modules')
    files.changedPaths.add('/app/package-lock.json')
    writeText(context,'stdout','Dependencies ready\n')
    return 0
  }
  if(!['run','run-script'].includes(args[0]??'')||!args[1]||!/^[A-Za-z0-9:_-]+$/.test(args[1]!)){
    writeText(context,'stderr',`Usage: ${manager} run <script> [-- args...]\n`)
    return 2
  }
  if(!runShellScript){writeText(context,'stderr',`${manager}: project scripts are unavailable\n`);return 1}
  let directory=files.resolvePath('.',cwd),manifestPath=''
  for(;;){
    const candidate=path.join(directory,'package.json')
    if(volume.existsSync(candidate)){manifestPath=candidate;break}
    if(directory==='/app')break
    directory=path.dirname(directory)
  }
  if(!manifestPath){writeText(context,'stderr',`${manager}: package.json not found\n`);return 1}
  let command:string
  let scripts:Record<string,unknown>
  try{
    const manifest=JSON.parse(String(volume.readFileSync(manifestPath))) as {scripts?:Record<string,unknown>}
    scripts=manifest.scripts??{}
    const declared=manifest.scripts?.[args[1]!]
    if(typeof declared!=='string'||!declared.trim())throw Error(`No package script named ${args[1]}`)
    command=declared
  }catch(error){writeText(context,'stderr',`${manager}: ${error instanceof Error?error.message:String(error)}\n`);return 1}
  const trailing=args.slice(args[2]==='--'?3:2)
  const quoted=trailing.map(value=>"'"+value.replaceAll("'","'\\''")+"'").join(' ')
  if(quoted)command+=' '+quoted
  const name=args[1]!
  const bins:string[]=[]
  for(let current=directory;;current=path.dirname(current)){
    bins.push('/project'+current.slice('/app'.length)+'/node_modules/.bin')
    if(current==='/app')break
  }
  const phases=manager==='npm'?[`pre${name}`,name,`post${name}`]:[name]
  for(const phase of phases){
    const script=phase===name?command:scripts[phase]
    if(typeof script!=='string'||!script.trim())continue
    context.signal.throwIfAborted()
    writeText(context,'stdout',`> ${phase}\n> ${script}\n`)
    const code=await runShellScript(`${manifestPath}:${phase}`,script,'/project'+directory.slice('/app'.length),
      {...env,PATH:[...bins,env.PATH].filter(Boolean).join(':'),npm_lifecycle_event:phase,npm_lifecycle_script:String(scripts[phase]),
        npm_package_json:manifestPath},context)
    if(code!==0)return code
  }
  return 0
}
function packageExecutable(name:string,cwd:string,env:Record<string,string>,files:NativeTerminalFileSession,volume:NativeFileOperations){
  const explicit=name.includes('/')
  const candidates=explicit?[name]:(env.PATH??'').split(':').filter(Boolean).map(dir=>path.join(dir,name))
  for(const candidate of candidates){
    let entry:string
    try{
      const parent=files.resolvePath(path.dirname(candidate),cwd)
      const link=path.join(parent,path.basename(candidate))
      if(!volume.lstatSync(link).isFile()&&!volume.lstatSync(link).isSymbolicLink())continue
      entry=String(volume.realpathSync(link))
      if(entry!=='/app'&&!entry.startsWith('/app/'))throw Error('Executable resolves outside the project')
      if(!volume.statSync(entry).isFile())throw Error('Executable is not a file')
    }catch(error){
      if((error as {code?:string})?.code==='ENOENT')continue
      if(!explicit&&error&&typeof error==='object'&&'code' in error&&error.code==='ERR_OUTSIDE_CONTAINER_PATH')continue
      return {kind:'unsupported' as const,message:`Cannot run ${name}: ${error instanceof Error?error.message:String(error)}`}
    }
    const fd=volume.openSync(entry,'r')
    const bytes=new Uint8Array(256)
    let length=0
    try{length=volume.readSync(fd,bytes,0,bytes.byteLength,0)}finally{volume.closeSync(fd)}
    const firstLine=new TextDecoder().decode(bytes.subarray(0,length)).split('\n',1)[0]!
    if(firstLine.startsWith('#!')&&!/^#!\s*(?:\/usr\/bin\/env(?:\s+-S)?\s+node(?:\s|$)|\/\S*\/node(?:\s|$))/.test(firstLine))
      return {kind:'unsupported' as const,message:`Unsupported package executable interpreter: ${firstLine}`}
    if(!firstLine.startsWith('#!')&&!/\.(?:mjs|cjs|js)$/.test(entry))
      return {kind:'unsupported' as const,message:`Unsupported package executable format: ${name}`}
    return {kind:'node' as const,entry}
  }
  return undefined
}
const programTable:Record<string,Program>={
  npm:context=>packageScript(context,'npm'),
  pnpm:context=>packageScript(context,'pnpm'),
  yarn:context=>packageScript(context,'yarn'),
  bun:context=>packageScript(context,'bun'),
  async node(context){
    const {args,cwd,env,files,volume,input,output,signal,createCommandWorker}=context
    if(!args.length){writeText(context,'stderr','Usage: node <script> | node -e <source> | node - [args...]\n');return 2}
    if(!createCommandWorker){writeText(context,'stderr','node: project command worker is unavailable\n');return 1}
    let launch:ReturnType<typeof parseNodeInvocation>
    try{
      launch=parseNodeInvocation(args)
      launch.entry=files.resolvePath(launch.entry,cwd)
      if(launch.evalSource===undefined&&!launch.stdinSource&&!volume.statSync(launch.entry).isFile())throw Error('Not a file')
    }catch(error){writeText(context,'stderr',`node: ${error instanceof Error?error.message:String(error)}\n`);return 1}
    const {entry,...options}=launch
    const child=createCommandWorker(entry,{...options,cwd:files.resolvePath('.',cwd),env})
    let childExited=false
    child.once('exit',()=>{childExited=true})
    const abort=()=>{void child.terminate()}
    signal.addEventListener('abort',abort,{once:true})
    child.on('stdout',(text:string)=>output('stdout',encoder.encode(text)))
    child.on('stderr',(text:string)=>output('stderr',encoder.encode(text)))
    child.on('stdout-bytes',(bytes:Uint8Array,done?:()=>void)=>{void output('stdout',bytes).finally(()=>done?.())})
    child.on('stderr-bytes',(bytes:Uint8Array,done?:()=>void)=>{void output('stderr',bytes).finally(()=>done?.())})
    child.on('error',(error:Error)=>output('stderr',encoder.encode(`${error.message}\n${error.stack??''}\n`)))
    void (async()=>{
      try{
        for await(const bytes of input){
          if(signal.aborted)break
          await child.writeInput(bytes)
        }
        if(!signal.aborted&&!childExited)await child.writeInput(null)
      }catch(error){if(!signal.aborted&&!childExited)output('stderr',encoder.encode(`${String(error)}\n`))}
    })()
    try{
      return await new Promise<number>(resolve=>child.once('exit',resolve))
    }finally{
      signal.removeEventListener('abort',abort)
      for(const path of child.changedPaths)files.changedPaths.add(path)
      await child.terminate()
    }
  },
  async cat({args,cwd,signal,input,output,files,volume}){
    let code=0
    const send=async(bytes:Uint8Array)=>{
      for(let offset=0;offset<bytes.byteLength;offset+=16384){
        if(signal.aborted)throw Error('Process terminated')
        await output('stdout',bytes.slice(offset,offset+16384))
      }
    }
    for(const name of args.length?args:['-']){
      if(name==='-'){
        for await(const bytes of input)await send(bytes)
        continue
      }
      try{
        const target=files.resolvePath(name,cwd)
        if(volume.statSync(target).isDirectory())throw Error('Is a directory')
        const fd=volume.openSync(target,'r')
        try{
          const buffer=new Uint8Array(16384)
          for(;;){
            const count=volume.readSync(fd,buffer,0,buffer.byteLength,null)
            if(!count)break
            await send(buffer.slice(0,count))
          }
        }finally{volume.closeSync(fd)}
      }catch(error){
        output('stderr',encoder.encode(`cat: ${name}: ${error instanceof Error?error.message:String(error)}\n`))
        code=1
      }
    }
    return code
  },
  async ls(context){
    const {args,cwd,files,volume}=context
    const flags=args[0]?.startsWith('-')?args.shift()!:'-'
    if(!/^-[al]*$/.test(flags)||args.length>1){writeText(context,'stderr','Usage: ls [-a] [-l] [directory]\n');return 2}
    try{
      const target=files.resolvePath(args[0]??'.',cwd)
      const directory=volume.statSync(target).isDirectory()
      const names=directory?volume.readdirSync(target).map(String).filter(name=>flags.includes('a')||!name.startsWith('.')).sort():[path.basename(target)]
      const lines=flags.includes('l')?names.map(name=>{
        const stat=volume.lstatSync(directory?path.join(target,name):target)
        const kind=stat.isDirectory()?'d':stat.isSymbolicLink()?'l':'-'
        return `${kind}${(stat.mode&0o777).toString(8).padStart(3,'0')} ${String(stat.size).padStart(8)} ${name}`
      }):names
      writeText(context,'stdout',lines.join(flags.includes('l')?'\n':'  ')+(lines.length?'\n':''))
      return 0
    }catch(error){writeText(context,'stderr',`ls: ${error instanceof Error?error.message:String(error)}\n`);return 1}
  },
  async mkdir(context){
    const {args,cwd,files,volume}=context
    const recursive=args[0]==='-p'
    if(recursive)args.shift()
    if(!args.length){writeText(context,'stderr','Usage: mkdir [-p] <directory>\n');return 2}
    let code=0
    for(const name of args){
      try{
        const target=files.resolvePath(name,cwd)
        volume.mkdirSync(target,{recursive});files.changedPaths.add(target)
      }catch(error){writeText(context,'stderr',`mkdir: ${name}: ${error instanceof Error?error.message:String(error)}\n`);code=1}
    }
    return code
  },
  async touch(context){
    const {args,cwd,files,volume}=context
    if(!args.length){writeText(context,'stderr','Usage: touch <file>\n');return 2}
    let code=0
    for(const name of args){
      try{
        const target=files.resolvePath(name,cwd)
        if(volume.existsSync(target))volume.utimesSync(target,new Date(),new Date())
        else volume.writeFileSync(target,'')
        files.changedPaths.add(target)
      }catch(error){writeText(context,'stderr',`touch: ${name}: ${error instanceof Error?error.message:String(error)}\n`);code=1}
    }
    return code
  },
  async cp(context){return copyOrMove(context,false)},
  async mv(context){return copyOrMove(context,true)},
  async rm(context){
    const {args,cwd,files,volume}=context
    let recursive=false,force=false
    while(args[0]?.startsWith('-')&&args[0]!=='--'){
      const flag=args.shift()!
      if(!/^-[rfR]+$/.test(flag)){writeText(context,'stderr','Usage: rm [-r] [-f] <path...>\n');return 2}
      recursive ||=flag.includes('r')||flag.includes('R')
      force ||=flag.includes('f')
    }
    if(args[0]==='--')args.shift()
    if(!args.length){writeText(context,'stderr','Usage: rm [-r] [-f] <path...>\n');return 2}
    let code=0
    for(const name of args){
      try{
        const target=files.resolvePath(name,cwd)
        if(target==='/app')throw Error('Cannot remove the project root')
        let paths:string[]
        try{paths=volumeTree(volume,target)}
        catch(error){if(force&&(error as {code?:string})?.code==='ENOENT')continue;throw error}
        if(volume.lstatSync(target).isDirectory()&&!recursive)throw Error('Is a directory')
        volume.rmSync(target,{recursive,force})
        for(const path of paths)files.changedPaths.add(path)
      }catch(error){writeText(context,'stderr',`rm: ${name}: ${error instanceof Error?error.message:String(error)}\n`);code=1}
    }
    return code
  },
  async help(context){
    writeText(context,'stdout','Available: pwd, cd, ls, cat, mkdir, touch, cp [-r], mv, rm [-r] [-f], sleep, stty size, node <script>, node -e <source>, node - [args...], npm/pnpm/yarn/bun run <script>, echo, printf, help. Shell pipes, variables, and redirection are supported.\n')
    return 0
  },
  async stty(context){
    if(context.args.length!==1||context.args[0]!=='size'){
      writeText(context,'stderr','Usage: stty size\n');return 2
    }
    const {columns,rows}=context.terminalSize()
    writeText(context,'stdout',`${rows} ${columns}\n`)
    return 0
  },
  async sleep(context){
    const value=context.args[0]
    const seconds=Number(value)
    if(context.args.length!==1||!value||!Number.isFinite(seconds)||seconds<0||seconds>30){
      writeText(context,'stderr','Usage: sleep <seconds between 0 and 30>\n')
      return 2
    }
    await new Promise<void>((resolve,reject)=>{
      if(context.signal.aborted){reject(Error('Process terminated'));return}
      const abort=()=>{clearTimeout(timer);reject(Error('Process terminated'))}
      const timer=setTimeout(()=>{context.signal.removeEventListener('abort',abort);resolve()},seconds*1000)
      context.signal.addEventListener('abort',abort,{once:true})
    })
    return 0
  },
}
export const nativeTerminalCommandNames=[...new Set(['cd','echo','printf','pwd',...Object.keys(programTable)])].sort()

async function copyOrMove(context:ProgramContext,move:boolean){
  const {args,cwd,files,volume}=context
  const command=move?'mv':'cp'
  let recursive=false
  if(!move&&['-r','-R'].includes(args[0]??'')){recursive=true;args.shift()}
  if(args.length!==2){writeText(context,'stderr',`Usage: ${command}${move?'':' [-r]'} <source> <destination>\n`);return 2}
  try{
    const source=files.resolvePath(args[0]!,cwd)
    let target=files.resolvePath(args[1]!,cwd)
    if(source==='/app')throw Error('Cannot move or copy the project root')
    const sourceDirectory=volume.lstatSync(source).isDirectory()
    if(sourceDirectory&&!move&&!recursive)throw Error('Use cp -r to copy a directory')
    if(volume.existsSync(target)&&volume.statSync(target).isDirectory())target=files.resolvePath(path.join(target,path.basename(source)),cwd)
    if(target==='/app'||target===source||sourceDirectory&&target.startsWith(source+'/'))
      throw Error('Destination must be outside the source')
    const originals=volumeTree(volume,source)
    if(move)volume.renameSync(source,target)
    else if(sourceDirectory)volume.cpSync(source,target,{recursive:true,dereference:false})
    else volume.copyFileSync(source,target)
    for(const original of originals){
      if(move)files.changedPaths.add(original)
      files.changedPaths.add(target+original.slice(source.length))
    }
    return 0
  }catch(error){writeText(context,'stderr',`${command}: ${error instanceof Error?error.message:String(error)}\n`);return 1}
}

function volumeTree(volume:NativeFileOperations,root:string):string[]{
  const paths:string[]=[],pending=[root]
  while(pending.length){
    const current=pending.pop()!
    paths.push(current)
    if(volume.lstatSync(current).isDirectory())
      for(const name of volume.readdirSync(current).map(String))pending.push(path.join(current,name))
  }
  return paths
}

class NativeShellProcess {
  #events:ProcessEvent[]=[]
  #eventWaiters:Array<(event:ProcessEvent|null)=>void>=[]
  #input:Uint8Array[]=[]
  #inputWaiters:Array<(bytes:Uint8Array|null)=>void>=[]
  #inputEnded=false
  #exited=false
  #disposed=false
  #bufferedOutput=0
  #outputReceipts=new Map<ProcessEvent,()=>void>()
  #bufferedInput=0
  #inputReceipts=new Map<Uint8Array,()=>void>()
  #controller=new AbortController()
  constructor(program:Program,context:Omit<ProgramContext,'signal'|'input'|'output'>){
    void program({...context,signal:this.#controller.signal,input:this.#readInput(),
      output:(stream,bytes)=>this.#publish({type:stream,bytes})})
      .then(code=>this.#publish({type:'exit',code}),error=>{
        if(!this.#controller.signal.aborted)
          this.#publish({type:'stderr',bytes:encoder.encode(`${error instanceof Error?error.message:String(error)}\n`)})
        this.#publish({type:'exit',code:this.#controller.signal.aborted?137:1})
      })
  }
  async *#readInput():AsyncGenerator<Uint8Array>{
    for(;;){
      if(this.#input.length){
        const bytes=this.#input.shift()!
        this.#bufferedInput-=bytes.byteLength
        this.#inputReceipts.get(bytes)?.();this.#inputReceipts.delete(bytes)
        yield bytes;continue
      }
      if(this.#inputEnded||this.#controller.signal.aborted)return
      const bytes=await new Promise<Uint8Array|null>(resolve=>this.#inputWaiters.push(resolve))
      if(bytes===null)return
      yield bytes
    }
  }
  #publish(event:ProcessEvent):Promise<void>{
    if(this.#disposed||this.#exited)return Promise.resolve()
    let receipt=Promise.resolve()
    if(event.type==='exit'){this.#exited=true;this.end()}
    else{
      this.#bufferedOutput+=event.bytes.byteLength
      if(this.#bufferedOutput>1024*1024){this.kill();return Promise.resolve()}
      receipt=new Promise(resolve=>this.#outputReceipts.set(event,resolve))
    }
    const waiter=this.#eventWaiters.shift()
    if(waiter){
      if(event.type!=='exit')this.#bufferedOutput-=event.bytes.byteLength
      this.#consume(event)
      waiter(event)
    }
    else this.#events.push(event)
    return receipt
  }
  #consume(event:ProcessEvent){this.#outputReceipts.get(event)?.();this.#outputReceipts.delete(event)}
  next():Promise<ProcessEvent|null>{
    const event=this.#events.shift()
    if(event){if(event.type!=='exit')this.#bufferedOutput-=event.bytes.byteLength;this.#consume(event);return Promise.resolve(event)}
    if(this.#exited||this.#disposed)return Promise.resolve(null)
    return new Promise(resolve=>this.#eventWaiters.push(resolve))
  }
  write(bytes:unknown){
    if(!(bytes instanceof Uint8Array)||bytes.byteLength>65536)throw Error('Invalid process input chunk')
    if(this.#inputEnded||this.#exited||this.#disposed)throw Object.assign(Error('Process input closed'),{code:'EPIPE'})
    const waiter=this.#inputWaiters.shift()
    if(waiter){waiter(bytes);return Promise.resolve()}
    else{
      this.#bufferedInput+=bytes.byteLength
      if(this.#bufferedInput>1024*1024)throw Error('Process input limit exceeded')
      this.#input.push(bytes)
      return new Promise<void>(resolve=>this.#inputReceipts.set(bytes,resolve))
    }
  }
  end(){
    this.#inputEnded=true
    for(const waiter of this.#inputWaiters.splice(0))waiter(null)
  }
  kill(){
    if(this.#exited||this.#disposed)return
    this.#controller.abort();this.end()
    for(const release of this.#inputReceipts.values())release()
    this.#inputReceipts.clear()
    for(const release of this.#outputReceipts.values())release()
    this.#outputReceipts.clear()
    this.#publish({type:'exit',code:137})
  }
  dispose(){
    this.kill();this.#disposed=true
    this.#events.length=0;this.#input.length=0
    for(const waiter of this.#eventWaiters.splice(0))waiter(null)
  }
}

/** Owns shell children and their stdin, output, exit, and disposal channels. */
export class NativeTerminalProcesses {
  #children=new Map<number,NativeShellProcess>()
  #next=0
  #size={columns:80,rows:24}
  constructor(private volume:NativeFileOperations,private files:NativeTerminalFileSession,
    private createCommandWorker?:NativeCommandWorkerFactory,
    private createShellWorker?:()=>Worker,private assetBaseURL?:string,
    private installPackages?:(signal:AbortSignal,onProgress:(text:string)=>void)=>Promise<void>){}
  resize(columns:number,rows:number){this.#size={columns,rows}}
  async #runPackageScript(name:string,script:string,cwd:string,env:Record<string,string>,context:ProgramContext){
    if(!this.createShellWorker||!this.assetBaseURL)throw Error('Project script shell is unavailable')
    if(context.scriptStack.includes(name))throw Error(`Project script cycle: ${name}`)
    if(context.scriptStack.length>=16)throw Error('Project script nesting limit exceeded')
    const scriptStack=[...context.scriptStack,name]
    const iterator=context.input[Symbol.asyncIterator]()
    const result=await runMvdanWorkerWithFactory({
        assetBaseURL:this.assetBaseURL,script,timeoutMs:30000,lifetime:'session',cwd,env,signal:context.signal,
        call:async(method,args)=>method.startsWith('process.')
          ?this.call(method,method==='process.spawn'?[...args,scriptStack]:args)
          :this.files.call(method,args),
        readStdin:async()=>{const next=await iterator.next();return next.done?null:next.value},
        writeStdout:async bytes=>context.output('stdout',bytes),
        writeStderr:async bytes=>context.output('stderr',bytes),
      },this.createShellWorker)
    return result.code
  }
  call(method:string,args:any[]):unknown{
    if(method==='process.spawn'){
      if(this.#children.size>=8)throw Error('Shell child limit exceeded')
      const [argv,cwd,env,scriptStack=[]]=args
      if(!Array.isArray(argv)||!argv.length||argv.some(value=>typeof value!=='string')||typeof cwd!=='string'||
        !env||typeof env!=='object'||Array.isArray(env)||Object.values(env).some(value=>typeof value!=='string')||
        !Array.isArray(scriptStack)||scriptStack.length>16||scriptStack.some(value=>typeof value!=='string'))
        throw Error('Invalid shell process request')
      this.files.resolvePath('.',cwd)
      let program=programTable[argv[0]]
      if(!program){
        const executable=packageExecutable(argv[0],cwd,env,this.files,this.volume)
        if(executable?.kind==='node')
          program=context=>programTable.node!({...context,args:[executable.entry,...context.args]})
        else if(executable?.kind==='unsupported')
          program=async context=>{writeText(context,'stderr',executable.message+'\n');return 126}
      }
      if(!program)throw Object.assign(Error(`Command not found: ${argv[0]}`),{code:'ENOENT'})
      const pid=++this.#next
      this.#children.set(pid,new NativeShellProcess(program,{args:argv.slice(1),cwd,env,scriptStack,files:this.files,volume:this.volume,
        terminalSize:()=>this.#size,createCommandWorker:this.createCommandWorker,
        installPackages:this.installPackages,
        runShellScript:this.createShellWorker?(name,script,cwd,env,context)=>this.#runPackageScript(name,script,cwd,env,context):undefined}))
      return pid
    }
    if(!method.startsWith('process.'))throw Error('Unsupported shell process operation')
    const pid=args[0]
    const child=typeof pid==='number'?this.#children.get(pid):undefined
    if(!child)throw Error('Unknown shell child')
    if(method==='process.next')return child.next()
    if(method==='process.write')return child.write(args[1])
    if(method==='process.end')return child.end()
    if(method==='process.kill')return child.kill()
    if(method==='process.dispose'){child.dispose();this.#children.delete(pid);return}
    throw Error('Unsupported shell process operation')
  }
  close(){for(const child of this.#children.values())child.dispose();this.#children.clear()}
}
