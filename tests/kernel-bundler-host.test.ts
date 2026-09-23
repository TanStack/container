import {expect,test,vi} from 'vitest'
import {WorkspaceFiles} from '../src/sandbox/files'
import {applyKernelBundlerFiles,createKernelBundlerHost,dispatchKernelBundlerCallback} from '../src/compiler/kernel-bundler-host'
const bytes=(value:string)=>new TextEncoder().encode(value)
test('bundler output commits changed files and preserves unrelated edits',()=>{
  const workspace=new WorkspaceFiles({'/entry.js':'original','/out/a.js':'old'})
  try{
    workspace.writeFileSync('/entry.js',bytes('edited during build'))
    applyKernelBundlerFiles(workspace,{'/out/a.js':bytes('new'),'/out/new.js':bytes('created')},{'/out/a.js':bytes('old'),'/out/new.js':null})
    expect(new TextDecoder().decode(workspace.readFileSync('/entry.js'))).toBe('edited during build')
    expect(new TextDecoder().decode(workspace.readFileSync('/out/a.js'))).toBe('new')
    expect(new TextDecoder().decode(workspace.readFileSync('/out/new.js'))).toBe('created')
  }finally{workspace.close()}
})
test('one changed output prevents every output from committing',()=>{
  const workspace=new WorkspaceFiles({'/out/a.js':'user edit','/out/b.js':'old'})
  try{
    const before=workspace.snapshot(),revision=workspace.revision
    expect(()=>applyKernelBundlerFiles(workspace,{'/out/b.js':bytes('new'),'/out/a.js':bytes('new')},{'/out/b.js':bytes('old'),'/out/a.js':bytes('old')})).toThrow('ECONFLICT')
    expect(workspace.snapshot()).toEqual(before)
    expect(workspace.revision).toBe(revision)
  }finally{workspace.close()}
})
test('output staging enforces workspace capacity without partial writes',()=>{
  const workspace=new WorkspaceFiles({'/a':'12'},4,4)
  try{
    const before=workspace.snapshot()
    expect(()=>applyKernelBundlerFiles(workspace,{'/b':bytes('3'),'/c':bytes('45')},{'/b':null,'/c':null})).toThrow()
    expect(workspace.snapshot()).toEqual(before)
  }finally{workspace.close()}
})
test('an output path replaced by a symlink is a conflict',()=>{
  const workspace=new WorkspaceFiles({'/source':'original'})
  try{
    workspace.symlinkSync('/source','/output')
    expect(()=>applyKernelBundlerFiles(workspace,{'/output':bytes('new')},{'/output':null})).toThrow('ECONFLICT')
    expect(new TextDecoder().decode(workspace.readFileSync('/source'))).toBe('original')
  }finally{workspace.close()}
})
test('host callback routes have scoped lifetime and release on close',async()=>{
  const workspace=new WorkspaceFiles({'/entry.js':'42'}),controller=new AbortController()
  let remoteCallback=0,queue=Promise.resolve()
  const parser={closed:false,createBundler:vi.fn(async()=>3),closeBundler:vi.fn(async()=>{}),invokeBundlerContext:vi.fn(async()=>({id:'/entry.js'})),runBundler:vi.fn(async(_handle,_method,options)=>{
    remoteCallback=options.inputOptions.onLog.id
    const reply=await dispatchKernelBundlerCallback(remoteCallback,['hello'],7,false)
    expect(reply).toBe('done')
    return {result:'encoded',watchFiles:['/entry.js'],closed:false,files:{},previousFiles:{}}
  })}
  const host=createKernelBundlerHost({files:workspace,signal:controller.signal,maxBytes:1024,getParser:async()=>parser as any,enqueue:work=>(queue=queue.then(work))})
  try{
    expect(host.pending).toBe(0)
    const handle=host.create(),operation=host.start(handle,'generate',{inputOptions:{onLog:{type:'guest-callback',id:1}}})
    expect(host.pending).toBe(1)
    const event:any=await host.next(operation)
    expect(event).toMatchObject({type:'callback',callbackId:1,args:['hello'],scope:7,sync:false})
    expect(host.snapshot()).toMatchObject({handles:1,nativeHandles:1,pending:1,queued:0,completed:0,failed:0,operationCount:1})
    expect(host.snapshot().operations[0]).toMatchObject({method:'generate',stage:'running-native',callbackCount:1})
    expect(host.hasScope(7)).toBe(true)
    await expect(host.context(7,5,'resolve',[])).resolves.toEqual({id:'/entry.js'})
    host.reply(operation,event.id,{type:'value',value:'done'})
    expect(host.hasScope(7)).toBe(false)
    expect(()=>host.context(7,5,'resolve',[])).toThrow('scope')
    await expect(host.next(operation)).resolves.toMatchObject({type:'result',value:{result:'encoded',watchFiles:['/entry.js']}})
    await queue
    expect(host.pending).toBe(0)
    expect(host.snapshot()).toMatchObject({completed:1,failed:0,callbacksCompleted:1})
    host.finish(operation)
    await host.close()
    expect(parser.closeBundler).toHaveBeenCalledExactlyOnceWith(3)
    await expect(dispatchKernelBundlerCallback(remoteCallback,[],7,false)).rejects.toThrow('unavailable')
  }finally{await host.close();workspace.close()}
})
test('two processes can reuse guest callback ids without sharing routes',async()=>{
  const remoteIds:number[]=[],workspaces:WorkspaceFiles[]=[],hosts:ReturnType<typeof createKernelBundlerHost>[]=[]
  for(const label of ['first','second']){
    const files=new WorkspaceFiles();workspaces.push(files)
    let queue=Promise.resolve()
    const parser={closed:false,createBundler:async()=>1,closeBundler:async()=>{},runBundler:async(_handle:number,_method:string,options:any)=>{
      const id=options.inputOptions.onLog.id;remoteIds.push(id)
      const reply=await dispatchKernelBundlerCallback(id,[label],1,false)
      return {result:reply,watchFiles:[],closed:false,files:{},previousFiles:{}}
    }}
    hosts.push(createKernelBundlerHost({files,signal:new AbortController().signal,maxBytes:1024,getParser:async()=>parser as any,enqueue:work=>(queue=queue.then(work))}))
  }
  try{
    const operations=hosts.map(host=>host.start(host.create(),'generate',{inputOptions:{onLog:{type:'guest-callback',id:1}}}))
    const events:any[]=await Promise.all(hosts.map((host,index)=>host.next(operations[index])))
    expect(new Set(remoteIds).size).toBe(2)
    expect(events.map(event=>event.callbackId)).toEqual([1,1])
    expect(events.map(event=>event.args)).toEqual([['first'],['second']])
    for(const index of [1,0])hosts[index].reply(operations[index],events[index].id,{type:'value',value:events[index].args[0]})
    const results:any[]=await Promise.all(hosts.map((host,index)=>host.next(operations[index])))
    expect(results.map(event=>event.value.result)).toEqual(['first','second'])
    hosts.forEach((host,index)=>host.finish(operations[index]))
    await hosts[0].close()
    await expect(dispatchKernelBundlerCallback(remoteIds[0],[],1,false)).rejects.toThrow('unavailable')
  }finally{await Promise.all(hosts.map(host=>host.close()));workspaces.forEach(files=>files.close())}
})
