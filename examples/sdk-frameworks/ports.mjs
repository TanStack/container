// These examples start one app per kernel. A listening port is not an HTTP
// readiness check, the preview still has to load the app successfully.
export function watchAppPort(kernel,timeoutMs=30000){
  let resolve,reject,unsubscribe,timer,settled=false
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no})
  // Startup can fail while spawn is pending, before the caller awaits the port.
  void promise.catch(()=>{})
  const finish=(error,port)=>{
    if(settled)return
    settled=true;clearTimeout(timer);unsubscribe?.()
    error?reject(error):resolve(port)
  }
  timer=setTimeout(()=>finish(Error('App did not open a port within '+timeoutMs+'ms')),timeoutMs)
  try{
    unsubscribe=kernel.subscribePorts(event=>{if(event.type==='open')finish(undefined,event.port)})
    if(settled)unsubscribe()
  }catch(error){finish(error)}
  return {promise,cancel:()=>finish(Error('App startup cancelled'))}
}
