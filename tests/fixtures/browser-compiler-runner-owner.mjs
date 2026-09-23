import {WorkspaceFiles} from '../../src/sandbox/files'
import {WorkspaceFileSessions} from '../../src/sandbox/workspace-file-sessions'
import {InputPipe} from '../../src/sandbox/guest-processes'
import {CompilerWorkspace} from '../../src/compiler/compiler-workspace'
import {runBrowserCompiler} from '../../src/compiler/browser-compiler-runner'
import {encodeRequest,decodeResponse} from './compiler-protocol.mjs'

export async function runRunnerWorkflow(){
  const files=new WorkspaceFiles({'/workspace/entry.ts':'import {answer} from "./answer"; export {answer}', '/workspace/answer.ts':'export const answer:number=42'},1024*1024,64)
  const sessions=new WorkspaceFileSessions(files),workspace=new CompilerWorkspace(sessions,true)
  const input=new InputPipe(),abort=new AbortController(),waiters=new Map(),logs=[]
  let buffer=new Uint8Array(),handshake=false,received=0,resolveReady,rejectReady,run
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject})
  const fail=error=>{rejectReady(error);for(const waiter of waiters.values())waiter.reject(error);waiters.clear()}
  try{
    const bytes=new Uint8Array(await(await fetch('/compiler.wasm')).arrayBuffer())
    run=runBrowserCompiler({createWorker:()=>new Worker('/runner-worker.js'),runtimeURL:new URL('/wasm_exec.js',location.href).href,
      bytes,maxMemoryPages:1024,argv:['esbuild','--service=0.28.2'],cwd:'/workspace',env:{PWD:'/workspace',TMPDIR:'/tmp'},timeoutMs:15000,signal:abort.signal,
      call:(method,args)=>workspace.call(method,args),readStdin:()=>input.read(),writeStderr:async bytes=>{logs.push(new TextDecoder().decode(bytes))},
      writeStdout:async bytes=>{
        received+=bytes.length;if(received>1024*1024)throw Error('Fixture output budget')
        const next=new Uint8Array(buffer.length+bytes.length);next.set(buffer);next.set(bytes,buffer.length);buffer=next
        while(buffer.length>=4){
          const size=new DataView(buffer.buffer,buffer.byteOffset,4).getUint32(0,true)
          if(size>1024*1024)throw Error('Fixture packet budget')
          if(buffer.length<size+4)break
          const packet=buffer.slice(4,size+4);buffer=buffer.slice(size+4)
          if(!handshake){if(new TextDecoder().decode(packet)!=='0.28.2')throw Error('Wrong compiler version');handshake=true;resolveReady()}
          else{const response=decodeResponse(packet),waiter=waiters.get(response.id);if(!waiter)throw Error('Unknown response');waiters.delete(response.id);waiter.resolve(response.value)}
        }
      },
    })
    void run.catch(fail)
    await ready
    const values=[]
    for(const answer of [42,43]){
      files.writeFileSync('/workspace/answer.ts',new TextEncoder().encode(`export const answer:number=${answer}`))
      const response=new Promise((resolve,reject)=>waiters.set(answer,{resolve,reject}))
      await input.write(encodeRequest(answer,{command:'build',key:answer,entries:[['','entry.ts']],flags:['--bundle','--format=esm','--outfile=/workspace/out/bundle.js'],write:true,stdinContents:null,stdinResolveDir:null,absWorkingDir:'/workspace',nodePaths:[],context:false}))
      const result=await response
      if(result.errors.length)throw Error(JSON.stringify(result.errors))
      const url=URL.createObjectURL(new Blob([files.readFileSync('/workspace/out/bundle.js')],{type:'text/javascript'}))
      try{values.push((await import(url)).answer)}finally{URL.revokeObjectURL(url)}
    }
    input.end()
    const result=await run
    workspace.close()
    return {values,result,handshake,logs,pending:waiters.size,resources:{descriptors:sessions.descriptors,sessions:sessions.size},actualSafari:false}
  }finally{
    abort.abort();input.close();workspace.close();await run?.catch(()=>{});sessions.close();files.close()
  }
}

export function capturedTransformFlags(options){
  const known=new Set(['charset','define','jsx','jsxDev','keepNames','legalComments','loader','minify','minifyIdentifiers','minifySyntax','minifyWhitespace','platform','sourcefile','sourcemap','supported','target','treeShaking','tsconfigRaw'])
  for(const key of Object.keys(options))if(!known.has(key))throw Error(`Unsupported captured transform option: ${key}`)
  const flags=['--log-level=silent','--log-limit=0']
  if(options.legalComments)flags.push(`--legal-comments=${options.legalComments}`)
  if(options.target)flags.push(`--target=${Array.isArray(options.target)?options.target.join(','):options.target}`)
  if(options.platform)flags.push(`--platform=${options.platform}`)
  if(options.tsconfigRaw)flags.push(`--tsconfig-raw=${typeof options.tsconfigRaw==='string'?options.tsconfigRaw:JSON.stringify(options.tsconfigRaw)}`)
  if(options.minify)flags.push('--minify')
  if(options.minifySyntax)flags.push('--minify-syntax')
  if(options.minifyWhitespace)flags.push('--minify-whitespace')
  if(options.minifyIdentifiers)flags.push('--minify-identifiers')
  if(options.charset)flags.push(`--charset=${options.charset}`)
  if(options.treeShaking!==undefined)flags.push(`--tree-shaking=${options.treeShaking}`)
  if(options.jsx)flags.push(`--jsx=${options.jsx}`)
  if(options.jsxDev)flags.push('--jsx-dev')
  if(options.keepNames)flags.push('--keep-names')
  for(const [key,value] of Object.entries(options.define??{}))flags.push(`--define:${key}=${value}`)
  for(const [key,value] of Object.entries(options.supported??{}))flags.push(`--supported:${key}=${value}`)
  if(options.sourcemap)flags.push(`--sourcemap=${options.sourcemap===true?'external':options.sourcemap}`)
  if(options.sourcefile)flags.push(`--sourcefile=${options.sourcefile}`)
  if(options.loader)flags.push(`--loader=${options.loader}`)
  return flags
}

export async function runCapturedTransformWorkflow(captures,rounds=2){
  if(!Array.isArray(captures)||captures.length!==15)throw Error('Expected the 15 captured Start transforms')
  if(rounds!==2)throw Error('Expected exactly two captured Start transform rounds')
  const files=new WorkspaceFiles({},1024*1024,64)
  const sessions=new WorkspaceFileSessions(files),workspace=new CompilerWorkspace(sessions,true)
  const input=new InputPipe(),abort=new AbortController(),waiters=new Map(),logs=[]
  let buffer=new Uint8Array(),handshake=false,received=0,resolveReady,rejectReady,run
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject})
  const fail=error=>{rejectReady(error);for(const waiter of waiters.values())waiter.reject(error);waiters.clear()}
  try{
    const bytes=new Uint8Array(await(await fetch('/compiler.wasm')).arrayBuffer())
    run=runBrowserCompiler({createWorker:()=>new Worker('/runner-worker.js'),runtimeURL:new URL('/wasm_exec.js',location.href).href,
      bytes,maxMemoryPages:1024,argv:['esbuild','--service=0.28.2'],cwd:'/workspace',env:{PWD:'/workspace',TMPDIR:'/tmp'},timeoutMs:30000,lifetime:'session',signal:abort.signal,
      call:(method,args)=>workspace.call(method,args),readStdin:()=>input.read(),writeStderr:async bytes=>{logs.push(new TextDecoder().decode(bytes))},
      writeStdout:async bytes=>{
        received+=bytes.length;if(received>16*1024*1024)throw Error('Fixture output budget')
        const next=new Uint8Array(buffer.length+bytes.length);next.set(buffer);next.set(bytes,buffer.length);buffer=next
        while(buffer.length>=4){
          const size=new DataView(buffer.buffer,buffer.byteOffset,4).getUint32(0,true)
          if(size>16*1024*1024)throw Error('Fixture packet budget')
          if(buffer.length<size+4)break
          const packet=buffer.slice(4,size+4);buffer=buffer.slice(size+4)
          if(!handshake){if(new TextDecoder().decode(packet)!=='0.28.2')throw Error('Wrong compiler version');handshake=true;resolveReady()}
          else{const response=decodeResponse(packet),waiter=waiters.get(response.id);if(!waiter)throw Error('Unknown response');waiters.delete(response.id);waiter.resolve(response.value)}
        }
      },
    })
    void run.catch(fail)
    await ready
    const outputs=[]
    let requestId=1
    for(let round=0;round<rounds;round++)for(const capture of captures){
      if(typeof capture?.input!=='string'||!capture.options||typeof capture.options!=='object')throw Error('Invalid captured transform')
      const id=requestId++
      const response=new Promise((resolve,reject)=>waiters.set(id,{resolve,reject}))
      await input.write(encodeRequest(id,{command:'transform',flags:capturedTransformFlags(capture.options),inputFS:false,input:new TextEncoder().encode(capture.input)}))
      const result=await response
      if(result.errors?.length)throw Error(JSON.stringify(result.errors))
      if(typeof result.code!=='string'||!result.code.length)throw Error('Empty captured transform output')
      outputs.push({round,sourcefile:capture.options.sourcefile,inputBytes:capture.input.length,codeBytes:result.code.length,mapBytes:result.map?.length??0,warnings:result.warnings?.length??0})
    }
    input.end()
    const result=await run
    workspace.close()
    return {result,handshake,logs,pending:waiters.size,outputs,resources:{descriptors:sessions.descriptors,sessions:sessions.size},actualSafari:false}
  }finally{
    abort.abort();input.close();workspace.close();await run?.catch(()=>{});sessions.close();files.close()
  }
}
