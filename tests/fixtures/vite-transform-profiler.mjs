import {writeFileSync} from 'node:fs'

// Diagnostic only. Keep the normal plugin result and receiver, and bound the
// trace so an unexpectedly large graph cannot fill the workspace with logs.
export function transformProfiler(output='/project/vite-transform-profile.json'){
  const events=[]
  const save=()=>writeFileSync(output,JSON.stringify(events))
  return {
    name:'probe-transform-profiler',
    enforce:'post',
    configResolved(config){
      for(const plugin of config.plugins){
        const hook=plugin.transform
        const handler=typeof hook==='function'?hook:hook?.handler
        if(!handler)continue
        const wrapped=function(...args){
          if(events.length>=1000)return handler.apply(this,args)
          const event={plugin:plugin.name,id:args[1],environment:this.environment?.name,start:performance.now()}
          events.push(event)
          const finish=(error)=>{event.end=performance.now();if(error!==undefined)event.error=String(error);save()}
          save()
          try{
            const result=handler.apply(this,args)
            if(result&&typeof result.then==='function')return result.then(value=>{finish();return value},error=>{finish(error);throw error})
            finish();return result
          }catch(error){finish(error);throw error}
        }
        plugin.transform=typeof hook==='function'?wrapped:{...hook,handler:wrapped}
      }
    },
  }
}
