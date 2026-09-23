import {fork} from 'node:child_process'
import {AsyncLocalStorage} from 'node:async_hooks'
const als=new AsyncLocalStorage()
const child=fork(new URL('./ipc-child.mjs',import.meta.url),[],{serialization:'advanced',stdio:'pipe',execArgv:[]})
const replies=[],callbacks=[]
let disconnected=false
child.on('disconnect',()=>{disconnected=!child.connected})
const completed=new Promise((resolve,reject)=>{
  child.on('error',reject)
  child.on('message',message=>{
    replies.push(message)
    if(message.kind==='ready'){
      als.run('sender',()=>{
        const payload={kind:'request',value:41,bytes:new Uint8Array([0,255]),bigint:123n}
        child.send(payload,error=>{if(error)reject(error);else callbacks.push(als.getStore())})
        payload.value=100
      })
    }else if(message.kind==='reply')child.send({kind:'finish'})
  })
  child.on('close',(code,signal)=>resolve({code,signal,disconnected,replies,callbacks}))
})
console.log(JSON.stringify(await completed))
