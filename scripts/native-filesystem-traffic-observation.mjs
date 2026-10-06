// Opt-in response instrumentation, not part of the SDK or release acceptance.
// Measures calls through one main worker's public provider objects. Calls made
// by compiler workers or captured inside the provider's async API are excluded.
export function installNativeFilesystemTrafficObservation({maxDurationMs=60000,maxOperations=250000,maxSummaries=20}={}){
  for(const [value,limit] of [[maxDurationMs,60000],[maxOperations,250000],[maxSummaries,20]])
    if(!Number.isInteger(value)||value<1||value>limit)throw TypeError('Invalid filesystem observation limit')
  const key=Symbol.for('tanstack-container:filesystem-traffic-observation-v1')
  if(self[key]||new URL(self.location.href).search)return
  const post=self.postMessage,restorations=[],stages={}
  const transitions={
    'filesystem-connected':'bootstrap','dependencies-install-started':'installation',
    'dependencies-installed':'bindings','config-runner-ready':'config',
    'entry-environment-ready':'config','config-loaded':'server-create',
    'vite-server-created':'listen','entry-ready':'listen','start-response-posted':'first-request',
  }
  const methods=['accessSync','appendFileSync','chmodSync','chownSync','closeSync','copyFileSync',
    'cpSync','existsSync','fchmodSync','fchownSync','fdatasyncSync','fstatSync','fsyncSync',
    'ftruncateSync','futimesSync','globSync','lchmodSync','lchownSync','linkSync','lstatSync',
    'lutimesSync','mkdirSync','mkdtempSync','openSync','opendirSync','readSync','readFileSync',
    'readdirSync','readlinkSync','realpathSync','renameSync','rmSync','rmdirSync','statSync',
    'statfsSync','symlinkSync','truncateSync','unlinkSync','utimesSync','writeSync','writeFileSync',
    'writeFileWithParentsSync']
  let active=false,started=false,phase='bootstrap',timer,startedAt=0,operations=0,summaries=0,restored=0
  const now=()=>{try{return performance.now()}catch{return startedAt}}
  const emit=(reason,complete,final=false)=>{
    if(summaries>=maxSummaries-(final?0:1))return
    summaries++
    try{console.info('FILESYSTEM_TRAFFIC_SUMMARY '+JSON.stringify({reason,complete,phase,
      durationMs:now()-startedAt,operations,stages,restored}))}catch{}
  }
  const stop=reason=>{
    if(!active)return
    active=false
    clearTimeout(timer)
    for(const restore of restorations){try{if(restore())restored++}catch{}}
    restorations.length=0
    if(self.postMessage===forward)self.postMessage=post
    emit(reason,reason==='first-request-ready',true)
  }
  const start=()=>{
    if(started)return
    started=true;startedAt=now()
    const provider=self[Symbol.for('tanstack-container:filesystem-provider-v1')]
    if(!provider?.fs||!provider?.vol){
      if(self.postMessage===forward)self.postMessage=post
      emit('provider-missing',false,true);return
    }
    active=true
    const wrappers=new Map()
    try{
      for(const object of new Set([provider.fs,provider.vol]))for(const name of methods){
        const original=object[name]
        if(typeof original!=='function')continue
        let wrapper=wrappers.get(original)
        if(!wrapper){
          wrapper=function(...args){
            const began=now(),stage=phase
            let failed=false,missing=false
            try{
              const value=Reflect.apply(original,this,args)
              missing=name==='existsSync'?value===false:
                (name==='statSync'||name==='lstatSync')&&value===undefined
              return value
            }catch(error){failed=true;try{missing=error?.code==='ENOENT'}catch{};throw error}
            finally{
              if(active){
                try{
                  const row=(stages[stage]??={})[name]??={count:0,totalMs:0,maxMs:0,errors:0,notFound:0}
                  const elapsed=Math.max(0,now()-began)
                  row.count++;row.totalMs+=elapsed;row.maxMs=Math.max(row.maxMs,elapsed)
                  if(failed)row.errors++
                  if(missing)row.notFound++
                  if(++operations>=maxOperations)stop('operation-limit')
                }catch{}
              }
            }
          }
          const properties=Object.getOwnPropertyDescriptors(original)
          delete properties.arguments;delete properties.caller;delete properties.prototype
          if(properties.native?.value===original)properties.native.value=wrapper
          Object.defineProperties(wrapper,properties)
          wrappers.set(original,wrapper)
        }
        const descriptor=Object.getOwnPropertyDescriptor(object,name)
        Object.defineProperty(object,name,{...descriptor,value:wrapper})
        restorations.push(()=>{
          if(object[name]!==wrapper)return false
          if(descriptor)Object.defineProperty(object,name,descriptor)
          else delete object[name]
          return true
        })
      }
      timer=setTimeout(()=>stop('duration-limit'),maxDurationMs)
    }catch{stop('setup-error')}
  }
  function forward(message,...args){
    try{
      if(message?.type==='native-dev-progress'){
        const next=transitions[message.phase]
        if(message.phase==='filesystem-connected')start()
        if(active&&next&&next!==phase){emit('stage',false);phase=next}
      }
    }catch{}
    return Reflect.apply(post,this,[message,...args])
  }
  Object.defineProperty(self,key,{value:Object.freeze({stop}),configurable:true})
  self.postMessage=forward
}

const source=`(${installNativeFilesystemTrafficObservation.toString()})();\n`
export function nativeFilesystemTrafficResponse(path,bytes,workerPaths,enabled){
  return enabled&&workerPaths.has(path)?source+bytes.toString('utf8'):bytes
}
