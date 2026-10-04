import {expect,it,vi} from 'vitest'
import {NativeDevServer} from '../src/native/dev-server'

it('restores host paths without detaching caller bytes and retains the old worker on validation failure',async()=>{
  const workers:any[]=[]
  vi.stubGlobal('location',{href:'https://sandbox.test/',origin:'https://sandbox.test'})
  vi.stubGlobal('Worker',class{
    onmessage:any;onerror:any;onmessageerror:any
    terminated=false
    starts:any[]=[]
    constructor(){workers.push(this);queueMicrotask(()=>this.onmessage({data:{type:'native-dev-ready'}}))}
    terminate(){this.terminated=true}
    postMessage(message:any){
      if(message.operation==='start')this.starts.push(message)
      const value=message.operation==='start'?{port:3000,webSocketToken:'token'}:new Uint8Array([7])
      queueMicrotask(()=>this.onmessage({data:{id:message.id,ok:true,value}}))
    }
  })
  const options={workerURL:'https://sandbox.test/engine.js',entry:'index.mjs',workspaceRoot:'/project'}
  const current=new NativeDevServer({},options)
  const bytes=new Uint8Array([0,128,255])
  const snapshot={version:5 as const,files:{'/project/data.bin':bytes},directories:['/project','/project/empty'],symlinks:{'/project/link':'/project/data.bin'},fileModes:{'/project/data.bin':0o640},directoryModes:{'/project':0o755,'/project/empty':0o750},fileTimes:{'/project/data.bin':{atimeMs:123,mtimeMs:456}}}
  let restored:NativeDevServer|undefined
  try{
    await current.ready
    await expect(current.restoreWorkspace(snapshot,options,async()=>{throw Error('Replacement not ready')})).rejects.toThrow('Replacement not ready')
    expect(workers[0].terminated).toBe(false)
    expect(workers[1].terminated).toBe(true)
    expect([...await current.readFile('/project/data.bin')]).toEqual([7])
    restored=await current.restoreWorkspace(snapshot,options)
    expect(workers[0].terminated).toBe(true)
    expect(workers[2].terminated).toBe(false)
    const mounted=workers[2].starts[0].restoreSnapshot
    expect(mounted.directories).toEqual(['/app','/app/empty'])
    expect(mounted.symlinks).toEqual({'/app/link':'/app/data.bin'})
    expect(mounted.fileModes).toEqual({'/app/data.bin':0o640})
    expect(mounted.fileTimes).toEqual({'/app/data.bin':{atimeMs:123,mtimeMs:456}})
    expect(mounted.files['/app/data.bin']).not.toBe(bytes)
    expect([...bytes]).toEqual([0,128,255])
    await expect(restored.restoreWorkspace({...snapshot,files:{'/outside':bytes}},options)).rejects.toThrow('inside /project')
    expect(workers).toHaveLength(3)
  }finally{current.close();restored?.close();vi.unstubAllGlobals()}
})
