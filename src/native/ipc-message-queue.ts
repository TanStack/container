import {EventEmitter} from '../vite-browser/node-events'

export function createIpcMessageQueue(events:EventEmitter,dispatch:(value:unknown)=>void){
  const pending:unknown[]=[]
  let scheduled=false
  let disconnected:(()=>void)|undefined
  let startupFinished=false
  const flush=()=>{
    if(scheduled||(!events.listenerCount('message')&&(!startupFinished||!disconnected)))return
    scheduled=true
    queueMicrotask(()=>{
      scheduled=false
      if(!events.listenerCount('message')&&(!startupFinished||!disconnected))return
      const messages=pending.splice(0)
      if(events.listenerCount('message'))for(const message of messages)dispatch(message)
      const close=disconnected;disconnected=undefined;close?.()
    })
  }
  events.on('newListener',event=>{if(event==='message')flushAfterAttach()})
  function flushAfterAttach(){queueMicrotask(flush)}
  return {finishStartup(){startupFinished=true;flush()},disconnect(close:()=>void){
    if(pending.length||scheduled){disconnected=close;flush()}
    else close()
  },receive(value:unknown){
    if(!events.listenerCount('message')||scheduled||pending.length){pending.push(value);flush()}
    else dispatch(value)
  }}
}
