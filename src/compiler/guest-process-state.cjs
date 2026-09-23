// One guest-owned object survives bootstrap and full Node facade initialization.
// Libraries may retain this reference before stdout and stderr are installed.
module.exports=function getGuestProcess(EventEmitter){
  const key=Symbol.for('web-container:process')
  if(globalThis[key])return globalThis[key]
  const process=new EventEmitter()
  const host=globalThis.__webContainerHost
  Object.assign(process,{
    browser:true,title:'browser',env:host?.env??{},argv:host?.argv??[],version:'',versions:{},
    nextTick(callback,...args){
      if(typeof callback!=='function')throw new TypeError('Expected a callback')
      const scheduler=globalThis[Symbol.for('web-container:task-queue')]
      if(!scheduler)throw new Error('Node task scheduling is unavailable in this backend')
      scheduler.nextTick(callback,...args)
    },
    cwd:()=>'/',
    chdir(){throw new Error('Process directories require the runtime')},
    binding(){throw new Error('Native process bindings are unavailable')},
  })
  return globalThis[key]=process
}
