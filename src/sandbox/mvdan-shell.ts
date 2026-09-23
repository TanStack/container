import type {WorkerKernel} from './kernel'
import {runMvdanWorker} from './mvdan-worker'

export interface ShellResult {code:number;stdout:Uint8Array;stderr:Uint8Array;error:string}
export interface ShellOptions {
  timeoutMs?:number
  writable?:boolean
  cwd?:string
  env?:Record<string,string>
  stdin?:Uint8Array
  signal?:AbortSignal
}

export async function runMvdanShell(kernel:WorkerKernel,script:string,{timeoutMs=5000,writable=false,cwd='/project',env={},stdin=new Uint8Array(),signal}:ShellOptions={}):Promise<ShellResult>{
  if(typeof script!=='string'||script.length>65536)throw Error('Shell script exceeds limit')
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('Invalid shell timeout')
  if(typeof cwd!=='string'||!cwd.startsWith('/')||cwd.length>4096||cwd.includes('\0'))throw Error('Invalid shell cwd')
  if(!env||typeof env!=='object'||Array.isArray(env))throw Error('Invalid shell environment')
  const entries=Object.entries(env)
  if(entries.length>128||entries.some(([key,value])=>!key||key.includes('=')||key.includes('\0')||typeof value!=='string'||value.includes('\0'))||JSON.stringify(env).length>32768)throw Error('Invalid shell environment')
  if(!(stdin instanceof Uint8Array)||stdin.byteLength>1024*1024)throw Error('Invalid shell stdin')
  if(signal!==undefined&&(!(signal instanceof AbortSignal)))throw Error('Invalid shell signal')
  const aborted=()=>{const error=new Error('Shell execution aborted');error.name='AbortError';return error}
  if(signal?.aborted)throw aborted()
  const session=await kernel.openFileSession({writable})
  type Child=Awaited<ReturnType<WorkerKernel['spawn']>>
  const children=new Map<number,Child>(),spawns=new Set<Promise<Child>>()
  let closing=false
  const call=async(method:string,args:any[])=>{
    if(closing)throw Error('Shell session closed')
    if(method==='process.spawn'){
      if(children.size+spawns.size>=8)throw Error('Shell child limit exceeded')
      const [command,...argv]=args[0]
      const pending=(async()=>{
        const child=await kernel.spawn(command,argv,{cwd:args[1],env:args[2],writable,guestWasm:true,webAPIs:true,timeoutMs,lifetime:'session'})
        if(closing){await child.dispose();throw Error('Shell session closed')}
        children.set(child.pid,child);return child
      })()
      spawns.add(pending)
      try{
        return (await pending).pid
      }finally{spawns.delete(pending)}
    }
    if(method.startsWith('process.')){
      const child=children.get(args[0])
      if(!child)throw Error('Unknown shell child')
      if(method==='process.next')return child.next()
      if(method==='process.end')return child.end()
      if(method==='process.kill')return child.kill('SIGKILL')
      if(method==='process.dispose'){await child.dispose();children.delete(child.pid);return}
      if(method==='process.write'){
        if(!(args[1] instanceof Uint8Array)||args[1].byteLength>65536)throw Error('Invalid shell stdin chunk')
        return child.write(args[1])
      }
      throw Error('Unsupported shell process operation')
    }
    return session.call(method,args)
  }
  const stdout:number[]=[],stderr:number[]=[]
  let offset=0
  const collect=async(target:number[],bytes:Uint8Array)=>{
    if(target.length+bytes.length>1024*1024)throw Error('shell output limit exceeded')
    for(const byte of bytes)target.push(byte)
  }
  try{
    const result=await runMvdanWorker({assetBaseURL:kernel.assetBaseURL,script,timeoutMs,cwd,env,signal,call,
      readStdin:async()=>{if(offset>=stdin.length)return null;const bytes=stdin.slice(offset,offset+16384);offset+=bytes.length;return bytes},
      writeStdout:bytes=>collect(stdout,bytes),writeStderr:bytes=>collect(stderr,bytes),
    })
    return {...result,stdout:Uint8Array.from(stdout),stderr:Uint8Array.from(stderr)}
  }finally{
    closing=true
    await Promise.allSettled([...spawns])
    try{await Promise.all([...children.values()].map(child=>child.dispose()))}
    finally{await session.close()}
  }
}
