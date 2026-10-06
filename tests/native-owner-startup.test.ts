import {expect,test,vi,beforeEach} from 'vitest'
const state=vi.hoisted(()=>({disposed:vi.fn(),restore:vi.fn(),created:vi.fn(),reinstall:vi.fn(),mkdir:vi.fn(),rename:vi.fn(),remove:vi.fn(),openTerminalSession:vi.fn()}))
vi.mock('../src/native/dev-server',()=>({NativeDevServer:class{
  constructor(...args:unknown[]){state.created(...args)}
  static restoreCheckpoint=state.restore
  subscribeEvents(){return ()=>{}}
  async waitForHTTPReady(){return 3000}
  dispose=state.disposed
  reinstall=state.reinstall
  mkdir=state.mkdir
  rename=state.rename
  remove=state.remove
  openTerminalSession=state.openTerminalSession
}}))
import {installNativeOwnerHost} from '../src/native/owner-transport'
beforeEach(()=>{state.disposed.mockReset();state.restore.mockReset();state.created.mockReset();state.reinstall.mockReset();state.mkdir.mockReset();state.rename.mockReset();state.remove.mockReset();state.openTerminalSession.mockReset()})

function connectedOwner(runtimeCandidates?:Array<{workerURL:string;toolchain:{vite:string;rolldown:string}}>,packageDownloadPolicy?:{additionalOrigins?:string[]}){
  let connect!:(event:any)=>void
  const parent={}
  vi.stubGlobal('location',new URL('http://owner.test/'));vi.stubGlobal('parent',parent)
  vi.stubGlobal('addEventListener',(_name:string,listener:any)=>{connect=listener})
  vi.stubGlobal('removeEventListener',vi.fn())
  const port={postMessage:vi.fn(),start:vi.fn(),close:vi.fn(),onmessage:undefined as any}
  const cleanup=installNativeOwnerHost({allowedParentOrigin:'http://app.test',workerURL:'/engine.js',runtimeCandidates,packageDownloadPolicy})
  connect({origin:'http://app.test',source:parent,data:{protocol:'native-owner-v1',type:'connect'},ports:[port]})
  const request=(id:number,operation:string,fields:Record<string,unknown>={})=>port.onmessage({data:{
    protocol:'native-owner-v1',type:'request',id,operation,files:{},options:{},cwd:'/app',...fields,
  },ports:[]}) as Promise<void>
  return {port,request,cleanup}
}

test('owner startup policy comes from the host, never the parent project request',async()=>{
  const {request,cleanup}=connectedOwner()
  try{
    await request(1,'start',{options:{packageDownloadPolicy:{additionalOrigins:['https://requested.example']}}})
    expect(state.created.mock.calls[0][1].packageDownloadPolicy).toEqual({additionalOrigins:[]})
  }finally{await cleanup();vi.unstubAllGlobals()}
})

test('configured owner policy reaches startup and the normal reinstall path',async()=>{
  const {request,cleanup}=connectedOwner(undefined,{additionalOrigins:['https://configured.example']})
  state.reinstall.mockResolvedValue({dispose:vi.fn(),subscribeEvents:()=>()=>{},waitForHTTPReady:async()=>3000})
  try{
    await request(1,'start',{options:{packageDownloadPolicy:{additionalOrigins:['https://requested.example']}}})
    const policy={additionalOrigins:['https://configured.example']}
    expect(state.created.mock.calls[0][1].packageDownloadPolicy).toEqual(policy)
    await request(2,'reinstall')
    expect(state.reinstall.mock.calls[0][0].packageDownloadPolicy).toEqual(policy)
  }finally{await cleanup();vi.unstubAllGlobals()}
})

test('host policy is captured before startup and preserved through restoration',async()=>{
  const additionalOrigins=['https://configured.example']
  const {request,cleanup}=connectedOwner(undefined,{additionalOrigins})
  additionalOrigins.push('https://later.example')
  state.restore.mockResolvedValue({dispose:vi.fn(),subscribeEvents:()=>()=>{},waitForHTTPReady:async()=>3000})
  try{
    await request(1,'restore',{options:{packageDownloadPolicy:{additionalOrigins:['https://requested.example']}},key:'checkpoint'})
    expect(state.restore.mock.calls[0][1].packageDownloadPolicy).toEqual({additionalOrigins:['https://configured.example']})
  }finally{await cleanup();vi.unstubAllGlobals()}
})

test('owner progress includes locked runtime preparation before worker creation',async()=>{
  const {request,port,cleanup}=connectedOwner([{workerURL:'/engine.js',toolchain:{vite:'8.3.1',rolldown:'1.2.11'}}])
  try{
    await request(1,'start',{options:{lock:{version:1,packages:[{installPath:'/node_modules/rolldown',version:'1.2.11'}]}}})
    const events=port.postMessage.mock.calls.map(([data])=>data).filter(data=>data.type==='event')
    expect(events.map(data=>data.event.phase)).toEqual(['owner-start-request-received',
      'owner-runtime-preparation-started','owner-runtime-preparation-completed','owner-worker-created'])
    expect(events.every(data=>Number.isFinite(data.event.elapsedMs)&&data.event.elapsedMs>=0)).toBe(true)
    expect(events.find(data=>data.event.phase==='owner-runtime-preparation-completed')?.event.durationMs).toBeGreaterThanOrEqual(0)
    expect(state.created).toHaveBeenCalledOnce()
    expect(port.postMessage.mock.calls.find(([data])=>data.type==='response'&&data.id===1)?.[0].value).toBe(3000)
  }finally{await cleanup();vi.unstubAllGlobals()}
})

test('failed owner progress delivery cannot replace a successful startup response',async()=>{
  const {request,port,cleanup}=connectedOwner()
  port.postMessage.mockImplementation(data=>{if(data.type==='event')throw Error('progress sink failed')})
  try{
    await request(1,'start')
    expect(state.created).toHaveBeenCalledOnce()
    expect(port.postMessage.mock.calls.find(([data])=>data.type==='response'&&data.id===1)?.[0]).toMatchObject({ok:true,value:3000})
  }finally{await cleanup();vi.unstubAllGlobals()}
})

test.each([false,true])('reinstall waits for an active persistent terminal command, rejection=%s',async(rejectCommand)=>{
  let finish!:(reject:boolean)=>void
  const session={runCommand:vi.fn(()=>new Promise((resolve,reject)=>{finish=fail=>fail?reject(Error('command failed')):resolve({exitCode:0})})),dispose:vi.fn(async()=>{})}
  state.openTerminalSession.mockResolvedValue(session)
  state.reinstall.mockResolvedValue({subscribeEvents:()=>()=>{},waitForHTTPReady:async()=>3000,dispose:vi.fn()})
  const {request,port,cleanup}=connectedOwner()
  let command:Promise<void>|undefined,installing:Promise<void>|undefined
  try{
    await request(1,'start');await request(2,'terminalSessionOpen')
    command=request(3,'terminalSessionRun',{sessionId:1,line:'node write-file.js'})
    await vi.waitFor(()=>expect(session.runCommand).toHaveBeenCalledOnce())
    installing=request(4,'reinstall')
    await request(5,'resources')
    expect(port.postMessage.mock.calls.find(([data])=>data.type==='response'&&data.id===5)?.[0].value.mutations).toBe(1)
    expect(state.reinstall).not.toHaveBeenCalled()
    finish(rejectCommand);await command;await installing
    expect(state.reinstall).toHaveBeenCalledOnce()
    expect(session.dispose).toHaveBeenCalledOnce()
    expect(port.postMessage.mock.calls.find(([data])=>data.type==='response'&&data.id===3)?.[0].ok).toBe(!rejectCommand)
    expect(port.postMessage.mock.calls.find(([data])=>data.type==='response'&&data.id===4)?.[0].ok).toBe(true)
  }finally{
    finish?.(false);await command;await installing;await cleanup();vi.unstubAllGlobals()
  }
})

test('opening a persistent terminal during reinstall waits for the replacement',async()=>{
  let finish!:(value:unknown)=>void
  state.reinstall.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const session={dispose:vi.fn(async()=>{})}
  const replacement={subscribeEvents:()=>()=>{},waitForHTTPReady:async()=>3000,openTerminalSession:vi.fn(async()=>session),dispose:vi.fn()}
  state.openTerminalSession.mockResolvedValue({dispose:vi.fn(async()=>{})})
  const {request,port,cleanup}=connectedOwner()
  let installing:Promise<void>|undefined,opening:Promise<void>|undefined
  try{
    await request(1,'start')
    installing=request(2,'reinstall')
    await vi.waitFor(()=>expect(state.reinstall).toHaveBeenCalledOnce())
    opening=request(3,'terminalSessionOpen')
    await Promise.resolve()
    expect(state.openTerminalSession).not.toHaveBeenCalled()
    expect(replacement.openTerminalSession).not.toHaveBeenCalled()
    finish(replacement);await installing;await opening
    expect(replacement.openTerminalSession).toHaveBeenCalledOnce()
    expect(port.postMessage.mock.calls.find(([data])=>data.type==='response'&&data.id===3)?.[0].ok).toBe(true)
  }finally{
    finish?.(replacement);await installing;await opening;await cleanup();vi.unstubAllGlobals()
  }
})
test.each(['mkdir','rename','remove'])('%s waits for an owner reinstall before mutating the replacement',async(operation)=>{
  let connect!:(event:any)=>void,finish!:(value:any)=>void
  state.reinstall.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const parent={}
  vi.stubGlobal('location',new URL('http://owner.test/'));vi.stubGlobal('parent',parent)
  vi.stubGlobal('addEventListener',(_name:string,listener:any)=>{connect=listener})
  vi.stubGlobal('removeEventListener',vi.fn())
  const port={postMessage:vi.fn(),start:vi.fn(),close:vi.fn(),onmessage:undefined as any}
  const cleanup=installNativeOwnerHost({allowedParentOrigin:'http://app.test',workerURL:'/engine.js'})
  const replacement={subscribeEvents:()=>()=>{},waitForHTTPReady:async()=>3000,mkdir:vi.fn(),rename:vi.fn(),remove:vi.fn(),dispose:vi.fn()}
  try{
    connect({origin:'http://app.test',source:parent,data:{protocol:'native-owner-v1',type:'connect'},ports:[port]})
    const request=(id:number,operation:string)=>port.onmessage({data:{protocol:'native-owner-v1',type:'request',id,operation,files:{},options:{},path:'/app/new',from:'/app/old',to:'/app/new'},ports:[]})
    await request(1,'start')
    const installing=request(2,'reinstall')
    await vi.waitFor(()=>expect(state.reinstall).toHaveBeenCalledOnce())
    const mutation=request(3,operation)
    await Promise.resolve()
    expect(state[operation]).not.toHaveBeenCalled()
    expect(replacement[operation]).not.toHaveBeenCalled()
    finish(replacement);await installing;await mutation
    expect(state[operation]).not.toHaveBeenCalled()
    expect(replacement[operation]).toHaveBeenCalledOnce()
    expect(port.postMessage.mock.calls.some(([value])=>value.id===3&&value.ok===false)).toBe(false)
  }finally{await cleanup();vi.unstubAllGlobals()}
})
test('disposing during dependency resolution aborts fetch and never creates a stale worker',async()=>{
  let connect!:(event:any)=>void,signal:AbortSignal|undefined
  const parent={}
  vi.stubGlobal('location',new URL('http://owner.test/'));vi.stubGlobal('parent',parent)
  vi.stubGlobal('addEventListener',(_name:string,listener:any)=>{connect=listener})
  vi.stubGlobal('removeEventListener',vi.fn())
  vi.stubGlobal('fetch',(_url:unknown,options:RequestInit)=>new Promise((_,reject)=>{
    signal=options.signal!
    signal.addEventListener('abort',()=>reject(signal!.reason),{once:true})
  }))
  const port={postMessage:vi.fn(),start:vi.fn(),close:vi.fn(),onmessage:undefined as any}
  const cleanup=installNativeOwnerHost({allowedParentOrigin:'http://app.test',workerURL:'/engine.js',runtimeCandidates:[{workerURL:'/engine.js',toolchain:{vite:'8.3.1',rolldown:'1.2.11'}}]})
  try{
    connect({origin:'http://app.test',source:parent,data:{protocol:'native-owner-v1',type:'connect'},ports:[port]})
    const request=(id:number,operation:string,options:unknown={})=>port.onmessage({data:{protocol:'native-owner-v1',type:'request',id,operation,files:{'/app/package.json':'{"dependencies":{"rolldown":"1.2.11"}}'},options},ports:[]})
    const pending=request(1,'start')
    await vi.waitFor(()=>expect(signal).toBeDefined())
    expect(state.created).not.toHaveBeenCalled()
    await request(2,'dispose');await pending
    expect(signal!.aborted).toBe(true)
    expect(state.created).not.toHaveBeenCalled()
    expect(port.postMessage.mock.calls.some(([value])=>value.id===1&&value.ok===false)).toBe(true)
    await request(3,'start',{lock:{version:1,packages:[{installPath:'/node_modules/rolldown',version:'1.2.11'}]}})
    expect(state.created).toHaveBeenCalledOnce()
    expect(state.disposed).not.toHaveBeenCalled()
  }finally{await cleanup();vi.unstubAllGlobals()}
})
test.each(['duplicate','dispose'])('pending restore ownership survives %s correctly',async(mode)=>{
  let connect!:(event:any)=>void,finish!:(value:any)=>void
  state.restore.mockImplementation(()=>new Promise(done=>{finish=done}))
  const parent={}
  vi.stubGlobal('location',new URL('http://owner.test/'));vi.stubGlobal('parent',parent)
  vi.stubGlobal('addEventListener',(_name:string,listener:any)=>{connect=listener})
  vi.stubGlobal('removeEventListener',vi.fn())
  const port={postMessage:vi.fn(),start:vi.fn(),close:vi.fn(),onmessage:undefined as any}
  const cleanup=installNativeOwnerHost({allowedParentOrigin:'http://app.test',workerURL:'/engine.js'})
  const restored={dispose:vi.fn(),subscribeEvents:()=>()=>{},waitForHTTPReady:async()=>3000}
  try{
    connect({origin:'http://app.test',source:parent,data:{protocol:'native-owner-v1',type:'connect'},ports:[port]})
    const request=(id:number,operation:string)=>port.onmessage({data:{protocol:'native-owner-v1',type:'request',id,operation,files:{},options:{},key:'checkpoint'},ports:[]})
    const pending=request(1,'restore')
    await request(2,mode==='duplicate'?'start':'dispose')
    if(mode==='dispose')await request(3,'start')
    finish(restored);await pending
    expect(state.disposed).not.toHaveBeenCalled()
    if(mode==='duplicate'){
      expect(restored.dispose).not.toHaveBeenCalled()
      expect(port.postMessage.mock.calls.some(([value])=>value.id===2&&value.ok===false)).toBe(true)
    }else{
      expect(restored.dispose).toHaveBeenCalledOnce()
      expect(port.postMessage.mock.calls.some(([value])=>value.id===1&&value.ok===false)).toBe(true)
    }
  }finally{await cleanup();vi.unstubAllGlobals()}
})
test('rejecting a second start does not dispose the running project',async()=>{
  let connect!:(event:any)=>void
  const parent={}
  vi.stubGlobal('location',new URL('http://owner.test/'))
  vi.stubGlobal('parent',parent)
  vi.stubGlobal('addEventListener',(_name:string,listener:any)=>{connect=listener})
  vi.stubGlobal('removeEventListener',vi.fn())
  const port={postMessage:vi.fn(),start:vi.fn(),close:vi.fn(),onmessage:undefined as any}
  const cleanup=installNativeOwnerHost({allowedParentOrigin:'http://app.test',workerURL:'/engine.js',runtimeCandidates:[{workerURL:'/engine.js',toolchain:{vite:'8.3.1',rolldown:'1.2.11'}}]})
  try{
    connect({origin:'http://app.test',source:parent,data:{protocol:'native-owner-v1',type:'connect'},ports:[port]})
    const lock={version:1,packages:[{installPath:'/node_modules/rolldown',version:'1.2.11'}]}
    const request=(id:number)=>port.onmessage({data:{protocol:'native-owner-v1',type:'request',id,operation:'start',files:{'/project/package.json':'{}'},options:{workspaceRoot:'/project',lock,assetBaseURL:'https://other.test/runtime/'}},ports:[]})
    await request(1);await request(2)
    expect(state.disposed).not.toHaveBeenCalled()
    expect(state.created).toHaveBeenCalledOnce()
    expect(state.created.mock.calls[0][0]).toEqual({'/project/package.json':'{}'})
    expect(state.created.mock.calls[0][1].lock).toBe(lock)
    expect(state.created.mock.calls[0][1].assetBaseURL).toBe('http://owner.test/runtime/')
    expect(port.postMessage.mock.calls.some(([value])=>value.id===2&&value.ok===false)).toBe(true)
  }finally{await cleanup();vi.unstubAllGlobals()}
})
