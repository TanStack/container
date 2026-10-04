interface ProcessEvents{
  on(event:string,listener:(...args:any[])=>void):unknown
  removeListener(event:string,listener:(...args:any[])=>void):unknown
  listenerCount(event:string):number
}

/** Node starts a fork's IPC channel unreferenced until it has listeners. */
export function trackIpcChannelLifetime(events:ProcessEvents,keepAlive:()=>()=>void){
  let connected=true
  let release:(()=>void)|undefined
  const relevant=(event:string)=>event==='message'||event==='disconnect'
  const ref=()=>{if(connected&&!release)release=keepAlive()}
  const unref=()=>{release?.();release=undefined}
  const added=(event:string)=>{if(relevant(event))ref()}
  const removed=(event:string)=>{
    if(relevant(event)&&!events.listenerCount('message')&&!events.listenerCount('disconnect'))unref()
  }
  events.on('newListener',added)
  events.on('removeListener',removed)
  if(events.listenerCount('message')||events.listenerCount('disconnect'))ref()
  return {
    disconnect(){connected=false;unref()},
    dispose(){connected=false;unref();events.removeListener('newListener',added);events.removeListener('removeListener',removed)},
  }
}
