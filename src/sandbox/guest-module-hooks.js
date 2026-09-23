function createModuleHooks(baseResolve,baseLoad){
 const hooks=[]
 const preparing=new Set()
 const unsupported=message=>Object.assign(Error(message),{code:'ERR_UNSUPPORTED_OPERATION'})
 const fileURL=path=>'file://'+path.split('/').map(encodeURIComponent).join('/')
 function registerHooks(options){
  if(!options||typeof options!=='object')throw new TypeError('Expected module hooks')
  for(const key of Object.keys(options))if(!['resolve','load'].includes(key)&&options[key]!==undefined)throw unsupported('Module '+key+' hooks are not implemented')
  if(options.resolve!==undefined&&typeof options.resolve!=='function')throw new TypeError('Expected resolve hook function')
  if(hooks.length>=64)throw unsupported('Module hook limit exceeded')
  if(options.load!==undefined&&typeof options.load!=='function')throw new TypeError('Expected load hook function')
  const entry={resolve:options.resolve,load:options.load};hooks.push(entry)
  return {deregister(){const index=hooks.indexOf(entry);if(index!==-1)hooks.splice(index,1)}}
 }
 function resolve(specifier,parent,mode){
  const chain=hooks.slice(),conditions=['node',mode,'module-sync']
  if(!chain.length)return baseResolve(specifier,parent,mode)
  const context={parentURL:parent.startsWith('/')?fileURL(parent):parent,conditions,importAttributes:{}}
  const invoke=(index,specifier,context)=>{
   if(index<0){const record=JSON.parse(baseResolve(specifier,context.parentURL,mode));return {url:record.id.startsWith('/')?fileURL(record.id):record.id,format:record.kind}}
   if(!chain[index].resolve)return invoke(index-1,specifier,context)
   let called=false
   const result=chain[index].resolve(specifier,context,(next=specifier,nextContext=context)=>{called=true;return invoke(index-1,next,nextContext)})
   if(result&&typeof result.then==='function')throw unsupported('Asynchronous resolve hooks require a loader scheduling barrier')
   if(!result||typeof result.url!=='string')throw new TypeError('Module resolve hook must return a URL')
   if(!called&&result.shortCircuit!==true)throw Object.assign(Error('Resolve hook did not call nextResolve or short circuit'),{code:'ERR_LOADER_CHAIN_INCOMPLETE'})
   return result
  }
  const result=invoke(chain.length-1,specifier,context)
  if(!/^(file:|node:|data:)/.test(result.url))throw new TypeError('Module resolve hook returned an unsupported URL')
  const record=JSON.parse(baseResolve(result.url,parent,mode))
  if(result.format!==undefined&&result.format!==record.kind)throw unsupported('Changing module format in a resolve hook')
  return JSON.stringify(record)
 }
 function load(url){
  if(url.startsWith('/'))url=fileURL(url)
  if(preparing.has(url))throw unsupported('Module source preparation is still pending; await preloadModuleSources before importing')
  const initial=baseLoad(url),chain=hooks.slice()
  const invoke=(index,url,context)=>{
   if(index<0)return url===initialURL?initial:baseLoad(url)
   if(!chain[index].load)return invoke(index-1,url,context)
   let called=false
   const result=chain[index].load(url,context,(next=url,nextContext=context)=>{called=true;return invoke(index-1,next,nextContext)})
   if(result&&typeof result.then==='function')throw unsupported('Asynchronous load hooks require explicit source preparation before import')
   if(!called&&result?.shortCircuit!==true)throw Object.assign(Error('Load hook did not call nextLoad or short circuit'),{code:'ERR_LOADER_CHAIN_INCOMPLETE'})
   return result
  }
  const initialURL=url
  const result=invoke(chain.length-1,url,{format:initial.format,importAttributes:{}})
  if(!result||result.format!==initial.format)throw unsupported('Changing module format in a load hook')
  if(result.format==='builtin'){if(result.source!==undefined)throw unsupported('Transforming builtin module source');return result}
  if(typeof result.source!=='string'){
   if(result.source instanceof ArrayBuffer)result.source=new TextDecoder().decode(new Uint8Array(result.source))
   else if(ArrayBuffer.isView(result.source))result.source=new TextDecoder().decode(result.source)
   else throw new TypeError('Load hook must return source text or bytes')
  }
  if(result.source.length>8*1024*1024)throw unsupported('Transformed module exceeds source limit')
  return result
 }
 // Explicit sandbox extension. Async work completes before a synchronous hook
 // is published, so QuickJS never has to suspend its module loader callbacks.
 async function preloadModuleSources(urls,loader,{data,signal}={}){
  if(!Array.isArray(urls)||!urls.length||urls.length>32||new Set(urls).size!==urls.length||urls.some(url=>typeof url!=='string'||!url.startsWith('file:')))throw new TypeError('Expected 1 to 32 distinct absolute file URLs')
  if(!loader||typeof loader.load!=='function')throw new TypeError('Expected an asynchronous source loader')
  if(signal!==undefined&&typeof signal?.aborted!=='boolean')throw new TypeError('Expected AbortSignal')
  if(loader.resolve!==undefined)throw unsupported('Preload requires explicit resolved URLs, not asynchronous resolution')
  if(urls.some(url=>preparing.has(url)))throw unsupported('Module source preparation is already pending')
  const check=()=>{if(signal?.aborted)throw Object.assign(Error('Module source preparation aborted'),{name:'AbortError',code:'ABORT_ERR'})}
  const sources=new Map();let total=0,disposed=false
  const dispose=async()=>{if(!disposed){disposed=true;await loader.dispose?.()}}
  for(const url of urls)preparing.add(url)
  try{
   check();await loader.initialize?.(data);check()
   for(const url of urls){
    const original=baseLoad(url)
    const result=await loader.load(url,{format:original.format,importAttributes:{}},async()=>original)
    check()
    if(!result||result.format!==original.format||!['module','commonjs','json'].includes(result.format)||typeof result.source!=='string')throw unsupported('Preload must preserve module format and return source text')
    total+=result.source.length
    if(result.source.length>8*1024*1024||total>16*1024*1024)throw unsupported('Preloaded source limit exceeded')
    sources.set(url,{format:result.format,source:result.source,shortCircuit:true})
   }
   await dispose();check()
   const registration=registerHooks({load:(url,context,next)=>sources.get(url)??next(url,context)})
   return {deregister(){registration.deregister();sources.clear()}}
  }catch(error){try{await dispose()}catch{}throw error}
  finally{for(const url of urls)preparing.delete(url)}
 }
 return {registerHooks,resolve,load,preloadModuleSources}
}
