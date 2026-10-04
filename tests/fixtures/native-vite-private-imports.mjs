export const nativeVitePrivateFiles = {
  'package.json': JSON.stringify({type:'module'}),
  'fixture/package.json': JSON.stringify({type:'module',imports:{'#target':'./target.js','#virtual':'./fallback.js'}}),
  'fixture/target.js': 'export const answer = 42',
  'fixture/fallback.js': 'export const value = -1',
  'fixture/entry.js': 'import {answer} from "#target"; import {value} from "#virtual"; export const result = answer + value',
}

export async function probeVitePrivateImports(createServer,{root,report=()=>{},timeoutMs=5000,rolldown,cold=false}) {
  const state={events:[],builtin:[],resolved:[],transformed:0,evaluated:0,virtualClaims:0,
    nestedClaims:0,bundleEvaluated:0,failures:[]}
  const record=row=>{state.events.push(row);if(state.events.length>256)state.events.shift();report(state)}
  const step=async(label,operation)=>{
    record({phase:'start',label})
    let timer
    try{
      const value=await Promise.race([operation(),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('Private-import control timed out: '+label)),timeoutMs)
      })])
      record({phase:'end',label});return value
    }catch(error){state.failures.push({label,error:String(error)});record({phase:'error',label,error:String(error)});throw error}
    finally{clearTimeout(timer)}
  }
  const virtualId='\0private-import-control',importer=root+'/fixture/entry.js'
  const server=await step('create-server',()=>createServer({root,configFile:false,envFile:false,logLevel:'silent',
    server:{middlewareMode:true,watch:null,hmr:false,preTransformRequests:false},
    optimizeDeps:{noDiscovery:true,include:[]},
    environments:{ssr:{resolve:{noExternal:true,conditions:['node','import','development']},
      optimizeDeps:{noDiscovery:true,include:[]}}},
    plugins:[{name:'private-import-control',enforce:'pre',
      resolveId:{filter:{id:/^#virtual$/},handler(id){
        if(id!=='#virtual')throw Error('Private import hook filter was not respected')
        state.virtualClaims++;record({phase:'virtual-claim',environment:this.environment?.name,id})
        return virtualId
      }},load(id){if(id===virtualId)return 'export const value = 84'}}]}))
  try{
    const environment=server.environments.ssr
    if(!environment)throw Error('Missing SSR environment')
    const plugin=environment.plugins.find(item=>item.name==='builtin:vite-resolve')
    if(!plugin)throw Error('Missing real Vite callable resolver')
    const hook=typeof plugin.resolveId==='function'?plugin.resolveId:plugin.resolveId?.handler
    if(typeof hook!=='function')throw Error('Missing built-in resolveId hook')
    const inspectBuiltin=async()=>{
      for(const id of ['./target.js','#target']){
        const value=await step('builtin:'+id,()=>Reflect.apply(hook,{environment},[id,importer,
          {kind:'dynamic-import',isEntry:false,attributes:{}}]))
        state.builtin.push({id,resolved:value?.id===root+'/fixture/target.js'?'fixture/target.js':value?.id??null,
          matched:value?.id===root+'/fixture/target.js'})
        record({phase:'builtin-result',...state.builtin.at(-1)})
      }
    }
    if(!cold)await inspectBuiltin()
    const resolve=async(label,id)=>{
      const value=await step(label,()=>environment.pluginContainer.resolveId(id,importer))
      const expected=id==='#virtual'?virtualId:root+'/fixture/target.js'
      if(value?.id!==expected)throw Error('Unexpected pipeline resolution: '+JSON.stringify({label,id,value}))
      state.resolved.push({label,id,resolved:id==='#virtual'?'virtual':'fixture/target.js'})
    }
    const resolveSequential=async()=>{
      await resolve('relative','./target.js');await resolve('private','#target');await resolve('virtual','#virtual')
    }
    const resolveConcurrent=()=>Promise.all(Array.from({length:18},(_,index)=>resolve('concurrent-'+index,
      ['./target.js','#target','#virtual'][index%3])))
    if(!cold){await resolveSequential();await resolveConcurrent()}
    await step('transform-entry',async()=>{
      const transformed=await environment.transformRequest(importer)
      if(!transformed?.code?.includes('result'))throw Error('Entry transform did not produce the module')
      state.transformed++
    })
    await step('evaluate-entry',async()=>{
      const evaluated=await server.ssrLoadModule(importer)
      if(evaluated?.result!==126)throw Error('Wrong evaluated value: '+evaluated?.result)
      state.evaluated++
    })
    // A cold module path forces another transform, rather than only reading the module cache.
    await step('evaluate-query-entry',async()=>{
      const evaluated=await server.ssrLoadModule(importer+'?second')
      if(evaluated?.result!==126)throw Error('Wrong query module value: '+evaluated?.result)
      state.evaluated++
    })
    if(rolldown)await step('nested-bundle',async()=>{
      const bundle=await rolldown({input:importer,logLevel:'silent',treeshake:false,
        plugins:[{name:'nested-vite-private-imports',async resolveId(id,from){
          if(!from||!id.startsWith('#'))return
          record({phase:'nested-resolve-start',id})
          const value=await environment.pluginContainer.resolveId(id,from)
          state.nestedClaims++;record({phase:'nested-resolve-end',id})
          return value
        },load(id){if(id===virtualId)return 'export const value = 84'}}]})
      try{
        const output=await bundle.generate({format:'esm'})
        const chunk=output.output.find(item=>item.type==='chunk'&&item.isEntry)
        if(!chunk)throw Error('Nested bundle did not produce an entry')
        const evaluated=await import('data:text/javascript,'+encodeURIComponent(chunk.code))
        if(evaluated.result!==126)throw Error('Wrong nested bundle value: '+evaluated.result)
        state.bundleEvaluated++
      }finally{await bundle.close()}
    })
    if(cold){await resolveConcurrent();await resolveSequential();await inspectBuiltin()}
  }catch(error){if(!state.failures.some(row=>row.error===String(error)))state.failures.push({label:'probe',error:String(error)})}
  finally{try{await step('close-server',()=>server.close())}catch{}}
  const passed=state.failures.length===0&&state.resolved.length===21&&state.transformed===1&&state.evaluated===2&&
    (!rolldown||state.nestedClaims===2&&state.bundleEvaluated===1)
  record({phase:'complete',passed})
  return {...state,passed,builtinMatched:state.builtin.length===2&&state.builtin.every(row=>row.matched)}
}
