import {expect,it,vi} from 'vitest'
import {NativeDevServer} from '../src/native/dev-server'

it('preserves worker stdout and stderr labels in live callbacks',async()=>{
  let raw:any
  vi.stubGlobal('location',{href:'https://sandbox.test/',origin:'https://sandbox.test'})
  vi.stubGlobal('Worker',class{
    onmessage:any;onerror:any;onmessageerror:any
    constructor(){raw=this}
    terminate(){}
    postMessage=vi.fn((message:any)=>{
      if(!['start','terminalCommand'].includes(message.operation))return
      queueMicrotask(()=>{
        if(message.operation==='terminalCommand'){
          this.onmessage({data:{type:'native-terminal-output',id:message.id,text:'out',stream:'stdout'}})
          this.onmessage({data:{type:'native-terminal-output',id:message.id,text:'err',stream:'stderr'}})
        }
        const value=message.operation==='start'?{port:3000,webSocketToken:'token'}:{cwd:'/app',stdout:'out',stderr:'err',exitCode:0,changedPaths:[]}
        this.onmessage({data:{id:message.id,ok:true,value}})
      })
    })
  })
  const additionalOrigins=['https://packages.example']
  const dev=new NativeDevServer({},{workerURL:'https://sandbox.test/engine.js',entry:'index.mjs',packageDownloadPolicy:{additionalOrigins}})
  try{
    additionalOrigins.push('https://later.example')
    raw.onmessage({data:{type:'native-dev-ready'}})
    expect(raw.postMessage.mock.calls.find(([message]:any)=>message.operation==='start')[0].packageDownloadPolicy).toEqual({additionalOrigins:['https://packages.example']})
    const output=vi.fn()
    const result=await dev.terminalCommand('command','/app',output)
    expect(output.mock.calls).toEqual([['out','stdout'],['err','stderr']])
    expect(result).toMatchObject({stdout:'out',stderr:'err'})
  }finally{dev.close();vi.unstubAllGlobals()}
})
