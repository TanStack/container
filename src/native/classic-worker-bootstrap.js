// Keep script loading synchronous while the runtime itself remains ESM.
(()=>{
Object.defineProperty(self,Symbol.for('tanstack.container.worker-type'),{value:'classic'})
const pending=[]
const queue=event=>{
  if(event.data?.type==='native-filesystem-bootstrap'){
    self[Symbol.for('tanstack-container:filesystem-bootstrap-v1')]=event.data
    return
  }
  pending.push(event);event.stopImmediatePropagation()
}
self.addEventListener('message',queue,true)
Promise.resolve().then(()=>{
  const parameters=new URL(self.location.href).searchParams
  const entry=new URL(parameters.get('native-engine-path')??'./engine.js',self.location.href)
  if(entry.origin!==self.location.origin||!['http:','https:'].includes(entry.protocol))
    throw new Error('Native engine URL must be on the worker origin')
  parameters.delete('native-engine-path')
  entry.search=parameters.toString()
  return import(entry.href)
}).then(()=>{
  self.removeEventListener('message',queue,true)
  for(const event of pending)
    self.dispatchEvent(new MessageEvent('message',{data:event.data,ports:event.ports}))
  pending.length=0
}).catch(error=>{
  self.removeEventListener('message',queue,true)
  pending.length=0
  self.postMessage({type:'native-dev-fatal',error:String(error),stack:error?.stack})
})
})()
