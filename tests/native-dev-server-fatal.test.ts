import {expect,it,vi} from 'vitest'
import {NativeDevServer} from '../src/native/dev-server'

it('failed cancellation transport rejects pending commands and closes the worker',async()=>{
  let raw:any
  const terminated=vi.fn()
  vi.stubGlobal('location',{href:'https://sandbox.test/',origin:'https://sandbox.test'})
  vi.stubGlobal('Worker',class{
    onmessage:any;onerror:any;onmessageerror:any
    constructor(){raw=this}
    terminate(){terminated()}
    postMessage(message:any){
      if(message.operation==='cancelTerminal')throw Error('Cancel transport failed')
      if(message.operation==='terminalSessionRun')return
      const value=message.operation==='start'?{port:3000,webSocketToken:'token'}:1
      queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,value}}))
    }
  })
  const dev=new NativeDevServer({}, {workerURL:'https://sandbox.test/engine.js',entry:'index.mjs'})
  try{
    raw.onmessage({data:{type:'native-dev-ready'}})
    await dev.ready
    const session=await dev.openTerminalSession()
    const controller=new AbortController()
    const pending=session.runCommand('cat',undefined,controller.signal)
    const rejected=expect(pending).rejects.toThrow('Cancel transport failed')
    controller.abort()
    await rejected
    expect(terminated).toHaveBeenCalledOnce()
    await expect(dev.readFile('/app/file.txt')).rejects.toThrow('closed')
  }finally{dev.close();vi.unstubAllGlobals()}
})

it('persistent terminal mutations advance the workspace revision but reads do not',async()=>{
  let raw:any
  vi.stubGlobal('location',{href:'https://sandbox.test/',origin:'https://sandbox.test'})
  vi.stubGlobal('Worker',class{
    onmessage:any;onerror:any;onmessageerror:any
    constructor(){raw=this}
    terminate(){}
    postMessage(message:any){
      const value=message.operation==='start'?{port:3000,webSocketToken:'token'}:
        message.operation==='terminalSessionOpen'?1:
        message.operation==='mkdir'?message.path!=='/app/existing':
        {cwd:'/app',stdout:'',stderr:'',exitCode:0,changedPaths:message.line==='touch file.txt'?['/app/file.txt']:[]}
      queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,value}}))
    }
  })
  const dev=new NativeDevServer({}, {workerURL:'https://sandbox.test/engine.js',entry:'index.mjs'})
  try{
    raw.onmessage({data:{type:'native-dev-ready'}})
    await dev.ready
    const session=await dev.openTerminalSession()
    try{
      expect(dev.workspaceRevision()).toBe(0)
      await session.runCommand('touch file.txt')
      expect(dev.workspaceRevision()).toBe(1)
      await session.runCommand('pwd')
      expect(dev.workspaceRevision()).toBe(1)
      await dev.mkdir('/app/nested',{recursive:true,mode:0o750})
      expect(dev.workspaceRevision()).toBe(2)
      await dev.mkdir('/app/existing',{recursive:true})
      expect(dev.workspaceRevision()).toBe(2)
      await expect(dev.mkdir('/outside')).rejects.toThrow('inside /app')
      expect(dev.workspaceRevision()).toBe(2)
    }finally{await session.dispose()}
  }finally{dev.close();vi.unstubAllGlobals()}
})

it('classic startup preserves the selected engine path and query',()=>{
  let selected:any
  vi.stubGlobal('location',{href:'https://sandbox.test/',origin:'https://sandbox.test'})
  vi.stubGlobal('Worker',class{
    constructor(url:URL,options:any){selected={url:new URL(url),options}}
    terminate(){}
  })
  const dev=new NativeDevServer({}, {workerURL:'https://sandbox.test/custom/selected.js?native-command=1',workerType:'classic'})
  void dev.ready.catch(()=>{})
  try{
    expect(selected.url.pathname).toBe('/custom/classic-worker-bootstrap.js')
    expect(selected.url.searchParams.get('native-engine-path')).toBe('/custom/selected.js')
    expect(selected.url.searchParams.get('native-command')).toBe('1')
    expect(selected.options.type).toBe('classic')
  }finally{dev.close();vi.unstubAllGlobals()}
})

it('rejects startup with the fatal error and preserves its atomic diagnostic',async()=>{
  let raw:any
  vi.stubGlobal('location',{href:'https://sandbox.test/',origin:'https://sandbox.test'})
  vi.stubGlobal('Worker',class{
    onmessage:any;onerror:any;onmessageerror:any;terminated=0
    constructor(){raw=this}
    terminate(){this.terminated++}
  })
  const dev=new NativeDevServer({}, {workerURL:'https://sandbox.test/engine.js'})
  const diagnostic={handles:[{kind:'socket',port:3000}],code:'ECONNRESET'}
  const rejected=dev.ready.catch(error=>error)
  try{
    raw.onmessage({data:{type:'native-dev-fatal',error:'reset',stack:'original stack',diagnostic}})
    const error=await rejected
    expect(error.message).toBe('reset')
    expect(error.stack).toBe('original stack')
    expect(error.diagnostic).toBe(diagnostic)
    expect(dev.diagnostics[0].diagnostic).toBe(diagnostic)
    expect(raw.terminated).toBe(1)
  }finally{dev.close();vi.unstubAllGlobals()}
})
