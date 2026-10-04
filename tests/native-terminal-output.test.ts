import {expect,it,vi} from 'vitest'
import {NativeDevServer} from '../src/native/dev-server'

it('preserves worker stdout and stderr labels in live callbacks',async()=>{
  let raw:any
  vi.stubGlobal('location',{href:'https://sandbox.test/',origin:'https://sandbox.test'})
  vi.stubGlobal('Worker',class{
    onmessage:any;onerror:any;onmessageerror:any
    constructor(){raw=this}
    terminate(){}
    postMessage(message:any){
      queueMicrotask(()=>{
        if(message.operation==='terminalCommand'){
          this.onmessage({data:{type:'native-terminal-output',id:message.id,text:'out',stream:'stdout'}})
          this.onmessage({data:{type:'native-terminal-output',id:message.id,text:'err',stream:'stderr'}})
        }
        const value=message.operation==='start'?{port:3000,webSocketToken:'token'}:{cwd:'/app',stdout:'out',stderr:'err',exitCode:0,changedPaths:[]}
        this.onmessage({data:{id:message.id,ok:true,value}})
      })
    }
  })
  const dev=new NativeDevServer({},{workerURL:'https://sandbox.test/engine.js',entry:'index.mjs'})
  try{
    raw.onmessage({data:{type:'native-dev-ready'}})
    const output=vi.fn()
    const result=await dev.terminalCommand('command','/app',output)
    expect(output.mock.calls).toEqual([['out','stdout'],['err','stderr']])
    expect(result).toMatchObject({stdout:'out',stderr:'err'})
  }finally{dev.close();vi.unstubAllGlobals()}
})
