import {afterEach,expect,test,vi} from 'vitest'
import {rolldownCompilerResources,rolldownParserPolicy,rolldownParserResources,rolldownSynchronousCompilerResources} from '../src/compiler/rolldown-parser-policy'
import {NativeRolldownParser,nativeParserAssetURL} from '../src/compiler/rolldown-parser'
import {WorkspaceFiles} from '../src/sandbox/files'
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
test('one owner session orders parser and callable commands and returns hook metadata',async()=>{
  vi.stubGlobal('crossOriginIsolated',true);vi.stubGlobal('location',{origin:'https://sandbox.test'})
  const files=new WorkspaceFiles({'/a.js':'1'}),snapshot=files.snapshot();files.close()
  const worker={onmessage:null as null|((event:{data:any})=>void),onerror:null,terminate:vi.fn(),postMessage:vi.fn((data:any,_transfers?:Transferable[])=>{
    if(data.type==='start')queueMicrotask(()=>worker.onmessage?.({data:{type:'ready'}}))
    if(data.type==='parse'||data.type==='callable')queueMicrotask(()=>worker.onmessage?.({data:{type:'result',id:data.id,value:data.command==='create'?{handle:1,hooks:[{name:'resolveId',order:'pre'}]}:{ok:true}}}))
    if(data.type==='close')queueMicrotask(()=>worker.onmessage?.({data:{type:'closed',resources:{active:0}}}))
  })}
  const createWorker=vi.fn(()=>worker as unknown as Worker)
  const session=await NativeRolldownParser.open({createWorker,wasmURL:'https://sandbox.test/parser.wasm',pthreadURL:'https://sandbox.test/pthread.js',policy:{timeoutMs:1000,maxSourceBytes:16},resolver:{snapshot,maxBytes:1024,maxFiles:16,callback:async()=>undefined}})
  expect(worker.postMessage.mock.calls[0][1]).toEqual([snapshot.files['/a.js'].buffer])
  expect(await session.createCallable({__name:'builtin:vite-resolve',options:{onWarn:{type:'callback'}}})).toEqual({handle:1,hooks:[{name:'resolveId',order:'pre'}]})
  await Promise.all([session.parse('/a.js','1'),session.updateCallable(1,'/a.js',new TextEncoder().encode('2')),session.resolveCallable(1,'./a.js','/entry.js',{})])
  expect(createWorker).toHaveBeenCalledOnce()
  expect(worker.postMessage.mock.calls.map(([data])=>data.command??data.type)).toEqual(['start','create','parse','update','resolve'])
  await session.disposeCallable(1);await session.close()
})
test('callback replies preserve undefined and reject nested compiler reentry',async()=>{
  vi.stubGlobal('crossOriginIsolated',true);vi.stubGlobal('location',{origin:'https://sandbox.test'})
  const files=new WorkspaceFiles(),snapshot=files.snapshot();files.close()
  let callbackResolve!:()=>void
  const callback=vi.fn(()=>new Promise<undefined>(resolve=>{callbackResolve=()=>resolve(undefined)}))
  const worker={onmessage:null as null|((event:{data:any})=>void),onerror:null,terminate:vi.fn(),postMessage:vi.fn((data:any)=>{
    if(data.type==='start')queueMicrotask(()=>worker.onmessage?.({data:{type:'ready'}}))
    if(data.type==='close')queueMicrotask(()=>worker.onmessage?.({data:{type:'closed',resources:{active:0}}}))
  })}
  const session=await NativeRolldownParser.open({createWorker:()=>worker as unknown as Worker,wasmURL:'https://sandbox.test/parser.wasm',pthreadURL:'https://sandbox.test/pthread.js',policy:{timeoutMs:1000,maxSourceBytes:16},resolver:{snapshot,maxBytes:1024,maxFiles:16,callback}})
  const buffer=new SharedArrayBuffer(65536+16),header=new Int32Array(buffer,0,4)
  worker.onmessage!({data:{type:'callback',handle:1,method:'onWarn',args:['hello'],buffer}})
  await expect(session.parse('a.js','1')).rejects.toThrow('Nested native calls')
  callbackResolve();await Promise.resolve();await Promise.resolve();await Promise.resolve()
  expect(Atomics.load(header,0)).toBe(1)
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,16,header[1])))).toEqual({kind:'undefined'})
  await session.close()
})
test('native parser is opt-in with separate fixed resource reservation',()=>{
  expect(rolldownParserPolicy(undefined)).toBeUndefined()
  expect(rolldownParserPolicy({timeoutMs:30000,maxSourceBytes:1024*1024})).toEqual({timeoutMs:30000,maxSourceBytes:1024*1024})
  expect(rolldownParserResources).toEqual({initialPages:4096,maximumPages:20480,maxWorkers:8,asyncWorkPoolSize:4})
  expect(rolldownSynchronousCompilerResources).toEqual({initialPages:1024,maximumPages:8192,maxWorkers:2,asyncWorkPoolSize:1})
  expect(rolldownCompilerResources('full')).toBe(rolldownParserResources)
  expect(rolldownCompilerResources('sync')).toBe(rolldownSynchronousCompilerResources)
  for(const value of [null,{},true,{timeoutMs:30001,maxSourceBytes:1},{timeoutMs:100,maxSourceBytes:0},{timeoutMs:100,maxSourceBytes:16*1024*1024+1},{timeoutMs:100,maxSourceBytes:1,extra:true}])expect(()=>rolldownParserPolicy(value)).toThrow()
})

test('validated independent parse waits behind native callback without changing FIFO or direct reentry guard',async()=>{
  vi.stubGlobal('crossOriginIsolated',true);vi.stubGlobal('location',{origin:'https://sandbox.test'})
  const files=new WorkspaceFiles(),snapshot=files.snapshot();files.close()
  let callbackResolve!:(value:undefined)=>void,activeId=0
  const buffer=new SharedArrayBuffer(65536+16)
  const worker={onmessage:null as null|((event:{data:any})=>void),onerror:null,terminate:vi.fn(),postMessage:vi.fn((data:any)=>{
    if(data.type==='start')queueMicrotask(()=>worker.onmessage?.({data:{type:'ready'}}))
    if(data.type==='callable'){activeId=data.id;queueMicrotask(()=>worker.onmessage?.({data:{type:'callback',handle:1,method:'onWarn',args:[],buffer}}))}
    if(data.type==='parse')queueMicrotask(()=>worker.onmessage?.({data:{type:'result',id:data.id,value:{program:data.source}}}))
    if(data.type==='close')queueMicrotask(()=>worker.onmessage?.({data:{type:'closed',resources:{active:0}}}))
  })}
  const session=await NativeRolldownParser.open({createWorker:()=>worker as unknown as Worker,wasmURL:'https://sandbox.test/parser.wasm',pthreadURL:'https://sandbox.test/pthread.js',policy:{timeoutMs:1000,maxSourceBytes:16},resolver:{snapshot,maxBytes:1024,maxFiles:16,callback:()=>new Promise(resolve=>{callbackResolve=resolve})}})
  const parent=session.resolveCallable(1,'x','y',{})
  await vi.waitFor(()=>expect(callbackResolve).toBeTypeOf('function'))
  await expect(session.parse('owned.js','1')).rejects.toThrow('Nested native calls')
  const independent=session.parse('independent.js','2',undefined,'callback-origin-validated')
  await expect(session.parse('oversized.js','x'.repeat(17),undefined,'callback-origin-validated')).rejects.toThrow('owner policy')
  const queued=Array.from({length:62},()=>session.parse('queued.js','3',undefined,'callback-origin-validated'))
  await expect(session.parse('overflow.js','4',undefined,'callback-origin-validated')).rejects.toThrow('pending request ceiling')
  await Promise.resolve()
  expect(worker.postMessage.mock.calls.filter(([row])=>row.type==='parse')).toHaveLength(0)
  callbackResolve(undefined)
  await vi.waitFor(()=>expect(Atomics.load(new Int32Array(buffer),0)).toBe(1))
  worker.onmessage!({data:{type:'result',id:activeId,value:'resolved'}})
  await expect(parent).resolves.toBe('resolved')
  await expect(independent).resolves.toEqual({program:'2'})
  await Promise.all(queued)
  expect(worker.postMessage.mock.calls.map(([row])=>row.type)).toEqual(['start','callable',...Array(63).fill('parse')])
  await session.close()
})

test.each(['transport','worker'])('close reports %s failure and waits for owned cleanup acknowledgement',async failure=>{
  vi.stubGlobal('crossOriginIsolated',true);vi.stubGlobal('location',{origin:'https://sandbox.test'})
  const worker={onmessage:null as null|((event:{data:unknown})=>void),onerror:null as null|((event:{message:string})=>void),terminate:vi.fn(),postMessage:vi.fn((data:any)=>{
    if(data.type==='start')queueMicrotask(()=>worker.onmessage?.({data:{type:'ready'}}))
    if(data.type==='close'){
      if(failure==='transport')throw Error('Transport unavailable')
      queueMicrotask(()=>worker.onerror?.({message:'Worker unavailable'}))
    }
    if(data.type==='abort')queueMicrotask(()=>worker.onmessage?.({data:{type:'closed',resources:{active:0}}}))
  })}
  const session=await NativeRolldownParser.open({createWorker:()=>worker as unknown as Worker,wasmURL:'https://sandbox.test/parser.wasm',pthreadURL:'https://sandbox.test/pthread.js',policy:{timeoutMs:30000,maxSourceBytes:4}})
  const close=session.close()
  await expect(close).rejects.toThrow(failure==='transport'?'Transport unavailable':'Worker unavailable')
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(session.cleanupStatus).toBe('acknowledged')
  expect(session.close()).toBe(close)
})
test('parser asset URLs require trusted same-origin HTTP assets',()=>{
  expect(nativeParserAssetURL('https://sandbox.test/parser.wasm','https://sandbox.test')).toBe('https://sandbox.test/parser.wasm')
  for(const url of ['https://other.test/parser.wasm','data:text/javascript,1','/relative','https://user:pass@sandbox.test/parser.wasm','https://sandbox.test/parser.wasm#fragment'])expect(()=>nativeParserAssetURL(url,'https://sandbox.test')).toThrow()
})
test('parser session preserves ordered responses, UTF-8 limits and acknowledged cleanup',async()=>{
  vi.stubGlobal('crossOriginIsolated',true);vi.stubGlobal('location',{origin:'https://sandbox.test'})
  const result={program:'{}',module:{},comments:[],errors:[]}
  const worker={onmessage:null as null|((event:{data:unknown})=>void),onerror:null,terminate:vi.fn(),postMessage:vi.fn((data:any)=>{
    if(data.type==='start')queueMicrotask(()=>worker.onmessage?.({data:{type:'ready'}}))
    if(data.type==='parse')queueMicrotask(()=>worker.onmessage?.({data:{type:'result',id:data.id,value:result}}))
    if(data.type==='close')queueMicrotask(()=>worker.onmessage?.({data:{type:'closed',resources:{active:0}}}))
  })}
  const session=await NativeRolldownParser.open({createWorker:()=>worker as unknown as Worker,wasmURL:'https://sandbox.test/parser.wasm',pthreadURL:'https://sandbox.test/pthread.js',policy:{timeoutMs:1000,maxSourceBytes:4}})
  expect(await session.parse('x.js','42')).toEqual(result)
  expect(session.closed).toBe(false)
  await expect(session.parse('x.js','€€')).rejects.toThrow('exceeds owner policy')
  const close=session.close();expect(session.close()).toBe(close);await close
  expect(worker.terminate).toHaveBeenCalledOnce()
  await expect(session.parse('x.js','')).rejects.toThrow('closed')
  expect(session.closed).toBe(true)
})

test('synchronous compiler reuses one bounded shared buffer across transforms',async()=>{
  vi.stubGlobal('crossOriginIsolated',true);vi.stubGlobal('location',{origin:'https://sandbox.test'})
  const buffers:SharedArrayBuffer[]=[]
  const worker={onmessage:null as null|((event:{data:unknown})=>void),onerror:null,terminate:vi.fn(),postMessage:vi.fn((data:any)=>{
    if(data.type==='start')queueMicrotask(()=>worker.onmessage?.({data:{type:'ready'}}))
    if(data.type==='sync'){
      buffers.push(data.buffer)
      const header=new Int32Array(data.buffer,0,4)
      const bytes=new TextEncoder().encode(JSON.stringify({value:{code:data.source,errors:[]}}))
      new Uint8Array(data.buffer,16,bytes.length).set(bytes)
      Atomics.store(header,1,bytes.length);Atomics.store(header,0,1);Atomics.notify(header,0)
    }
    if(data.type==='close')queueMicrotask(()=>worker.onmessage?.({data:{type:'closed',resources:{active:0}}}))
  })}
  const session=await NativeRolldownParser.open({createWorker:()=>worker as unknown as Worker,wasmURL:'https://sandbox.test/parser.wasm',pthreadURL:'https://sandbox.test/pthread.js',policy:{timeoutMs:1000,maxSourceBytes:128}})
  expect(session.transformSync('a.ts','1',{})).toEqual({code:'1',errors:[]})
  expect(session.transformSync('b.ts','export const answer = 42',{})).toEqual({code:'export const answer = 42',errors:[]})
  expect(session.transformSync('c.ts','3',{})).toEqual({code:'3',errors:[]})
  expect(buffers).toHaveLength(3)
  expect(new Set(buffers).size).toBe(1)
  expect(buffers[0].byteLength).toBe(144)
  await session.close()
})

test('close skips queued parses and waits only for the active request',async()=>{
  vi.stubGlobal('crossOriginIsolated',true);vi.stubGlobal('location',{origin:'https://sandbox.test'})
  const worker={onmessage:null as null|((event:{data:unknown})=>void),onerror:null,terminate:vi.fn(),postMessage:vi.fn((data:any)=>{
    if(data.type==='start')queueMicrotask(()=>worker.onmessage?.({data:{type:'ready'}}))
    if(data.type==='close')queueMicrotask(()=>worker.onmessage?.({data:{type:'closed',resources:{active:0}}}))
  })}
  const session=await NativeRolldownParser.open({createWorker:()=>worker as unknown as Worker,wasmURL:'https://sandbox.test/parser.wasm',pthreadURL:'https://sandbox.test/pthread.js',policy:{timeoutMs:1000,maxSourceBytes:4}})
  const active=session.parse('a.js','1')
  await Promise.resolve()
  const queued=session.parse('b.js','2')
  const rejected=expect(queued).rejects.toThrow('closed')
  const closing=session.close()
  worker.onmessage!({data:{type:'result',id:1,value:{program:'{}',module:{},comments:[],errors:[]}}})
  await active;await rejected;await closing
  expect(worker.postMessage.mock.calls.filter(([data])=>data.type==='parse').map(([data])=>data.filename)).toEqual(['a.js'])
  expect(worker.terminate).toHaveBeenCalledOnce()
})

test('queued request deadline starts at submission',async()=>{
  vi.useFakeTimers()
  vi.stubGlobal('crossOriginIsolated',true);vi.stubGlobal('location',{origin:'https://sandbox.test'})
  const worker={onmessage:null as null|((event:{data:unknown})=>void),onerror:null,terminate:vi.fn(),postMessage:vi.fn((data:any)=>{
    if(data.type==='start')Promise.resolve().then(()=>worker.onmessage?.({data:{type:'ready'}}))
  })}
  const session=await NativeRolldownParser.open({createWorker:()=>worker as unknown as Worker,wasmURL:'https://sandbox.test/parser.wasm',pthreadURL:'https://sandbox.test/pthread.js',policy:{timeoutMs:100,maxSourceBytes:4}})
  const first=session.parse('a.js','1'),second=session.parse('b.js','2')
  const outcomes=Promise.allSettled([first,second])
  await vi.advanceTimersByTimeAsync(90)
  worker.onmessage!({data:{type:'result',id:1,value:{program:'{}',module:{},comments:[],errors:[]}}})
  await vi.advanceTimersByTimeAsync(10)
  const results=await outcomes
  expect(results[0].status).toBe('fulfilled')
  expect(results[1]).toMatchObject({status:'rejected',reason:expect.objectContaining({message:'Native parser request deadline exceeded'})})
  expect(worker.terminate).not.toHaveBeenCalled()
  expect(session.cleanupStatus).toBe('pending')
  await vi.advanceTimersByTimeAsync(100)
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(session.cleanupStatus).toBe('unconfirmed')
})
