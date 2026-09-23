import {afterEach,expect,test,vi} from 'vitest'
import {NativeRolldownParser} from '../src/compiler/rolldown-parser'
import {WorkspaceFiles} from '../src/sandbox/files'
afterEach(()=>vi.unstubAllGlobals())

test.each([false,true])('a bundler callback can resolve while unrelated work remains ordered, throws=%s',async throws=>{
  vi.stubGlobal('crossOriginIsolated',true)
  vi.stubGlobal('location',{origin:'https://sandbox.test'})
  const workspace=new WorkspaceFiles({'/entry.js':'export const answer=42'})
  const snapshot=workspace.snapshot();workspace.close()
  const events:string[]=[]
  let buildId:number|undefined,session:NativeRolldownParser
  const worker={onmessage:null as null|((event:{data:any})=>void),onerror:null,terminate:vi.fn(),postMessage:vi.fn((data:any)=>{
    const reply=(value:any)=>queueMicrotask(()=>worker.onmessage?.({data:value}))
    if(data.type==='start')reply({type:'ready'})
    else if(data.type==='bundler'&&data.command==='run'){
      events.push('build');buildId=data.id
      reply({type:'bundler-callback',request:1,callbackId:1,args:['./entry.js'],scope:7,sync:false})
    }else if(data.type==='callable'){
      events.push('resolve:'+data.scope)
      reply({type:'result',id:data.id,value:'/entry.js'})
    }else if(data.type==='bundler-callback-reply'){
      events.push('callback-reply')
      if(throws){expect(data.error).toContain('plugin failed');reply({type:'result',id:buildId,error:data.error})}
      else{expect(data.value).toBe('/entry.js');reply({type:'result',id:buildId,value:{result:'built',files:{}}})}
    }else if(data.type==='parse'){
      events.push('parse');reply({type:'result',id:data.id,value:{program:'{}',module:{},comments:[],errors:[]}})
    }else if(data.type==='close')reply({type:'closed',resources:{active:0}})
  })}
  session=await NativeRolldownParser.open({createWorker:()=>worker as unknown as Worker,wasmURL:'https://sandbox.test/parser.wasm',pthreadURL:'https://sandbox.test/pthread.js',policy:{timeoutMs:1000,maxSourceBytes:1024},resolver:{snapshot,maxBytes:4096,maxFiles:16,callback:async()=>undefined,bundlerCallback:async(_id,args,scope,sync)=>{
    expect(sync).toBe(false)
    const value=await session.resolveCallable(1,args[0] as string,'/entry.js',{},scope)
    if(throws)throw Error('plugin failed')
    return value
  }}})
  try{
    const build=session.runBundler(1,'generate',{})
    const parse=session.parse('/entry.js','42')
    if(throws)await expect(build).rejects.toThrow('plugin failed')
    else await expect(build).resolves.toEqual({result:'built',files:{}})
    await parse
    expect(events).toEqual(['build','resolve:7','callback-reply','parse'])
    await expect(session.resolveCallable(1,'./entry.js','/entry.js',{},7)).rejects.toThrow('Expired native bundler callback scope')
    expect(events).toHaveLength(4)
  }finally{await session.close()}
  expect(worker.terminate).toHaveBeenCalledOnce()
})

test('the parser owner admits more than 64 concurrent bundler callbacks',async()=>{
  vi.stubGlobal('crossOriginIsolated',true)
  vi.stubGlobal('location',{origin:'https://sandbox.test'})
  const workspace=new WorkspaceFiles(),snapshot=workspace.snapshot();workspace.close()
  const releases:Array<()=>void>=[]
  const worker={onmessage:null as null|((event:{data:any})=>void),onerror:null,terminate:vi.fn(),postMessage:vi.fn((data:any)=>{
    if(data.type==='start')queueMicrotask(()=>worker.onmessage?.({data:{type:'ready'}}))
    else if(data.type==='close')queueMicrotask(()=>worker.onmessage?.({data:{type:'closed',resources:{active:0}}}))
  })}
  const session=await NativeRolldownParser.open({createWorker:()=>worker as unknown as Worker,wasmURL:'https://sandbox.test/parser.wasm',pthreadURL:'https://sandbox.test/pthread.js',policy:{timeoutMs:1000,maxSourceBytes:1024},resolver:{snapshot,maxBytes:4096,maxFiles:16,callback:async()=>undefined,bundlerCallback:()=>new Promise(resolve=>releases.push(()=>resolve('ok')))}})
  try{
    for(let index=1;index<=128;index++)worker.onmessage?.({data:{type:'bundler-callback',request:index,callbackId:1,args:[],scope:index,sync:false}})
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(releases).toHaveLength(128)
    for(const release of releases)release()
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(worker.postMessage.mock.calls.filter(([data])=>data.type==='bundler-callback-reply')).toHaveLength(128)
  }finally{await session.close()}
})
