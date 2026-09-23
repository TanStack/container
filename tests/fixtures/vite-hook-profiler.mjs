// Diagnostic only, preserve hook receivers, return values, metadata and errors.
export function hookProfiler(){
 let sequence=0
 return {name:'probe-hook-profiler',enforce:'post',configResolved(config){
  for(const plugin of config.plugins)for(const name of ['resolveId','load','transform']){
   const hook=plugin[name],handler=typeof hook==='function'?hook:hook?.handler
   if(!handler)continue
   const wrapped=function(...args){
    if(sequence>=128)return handler.apply(this,args)
    const id=++sequence,event={id,plugin:plugin.name,hook:name,module:String(args[name==='transform'?1:0]).slice(0,400),environment:this.environment?.name}
    const emit=phase=>console.log('START_HOOK '+JSON.stringify({...event,phase,time:performance.now()}))
    emit('start')
    try{const result=handler.apply(this,args);if(result&&typeof result.then==='function')return result.then(value=>{emit('end');return value},error=>{emit('error');throw error});emit('end');return result}catch(error){emit('error');throw error}
   }
   plugin[name]=typeof hook==='function'?wrapped:{...hook,handler:wrapped}
  }
 }}
}
