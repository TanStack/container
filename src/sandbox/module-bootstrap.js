// Evaluated in QuickJS. Module objects, wrappers, caches, and exports never
// leave the guest realm. Host hooks resolve paths and compile trusted or
// owner-selected source.
(()=>{
  const resolve=__moduleResolve,compileBuiltin=__moduleCompile,read=__moduleRead,describe=__moduleDescribe
  // Compiling an ordinary CommonJS wrapper through the owner callback reenters
  // QuickJS from the browser while the requiring module is still running. A
  // dependency chain then grows the browser's native stack even when QuickJS
  // itself uses iterative call frames. Keep that compilation in the guest so
  // nested require calls only consume the interpreter's bounded frame stack.
  // Builtins retain the owner compiler because trusted builtins can have
  // owner-selected compilation behavior.
  const hostCompilePaths=new Set(globalThis.__moduleHostCompilePaths??[])
  delete globalThis.__moduleHostCompilePaths
  const compileCommonJS=(path,source)=>hostCompilePaths.has(path)?compileBuiltin(path,source):Function('exports','require','module','__filename','__dirname',source+'\n//# sourceURL='+encodeURI(path))
  const requireESM=globalThis.__qjsRequireESM
  const adaptExports=globalThis.__moduleAdaptExports
  delete globalThis.__moduleAdaptExports
  delete globalThis.__qjsRequireESM
  delete globalThis.__moduleResolve;delete globalThis.__moduleCompile
  delete globalThis.__moduleRead;delete globalThis.__moduleDescribe
  const cache=Object.create(null),builtins=new Map(),loadingBuiltins=new Map()
  const baseLoad=__moduleLoad;delete globalThis.__moduleLoad
  const hooks=createModuleHooks(resolve,baseLoad)
  const loadSource=id=>hooks.load(id)
  let main
  function requireResolved(record,parent){
    const key=record.path
    if(record.kind==='builtin'&&builtins.has(key))return builtins.get(key)
    if(record.kind==='builtin'&&loadingBuiltins.has(key))return loadingBuiltins.get(key).exports
    if(record.kind!=='builtin'&&cache[key]){
      const child=cache[key];if(parent&&!parent.children.includes(child))parent.children.push(child)
      return child.exports
    }
    if(record.kind==='module'){
      if(!requireESM)throw Object.assign(new Error('This engine does not support synchronous require of ESM: '+key),{code:'ERR_REQUIRE_ESM'})
      const namespace=requireESM(record.id??key)
      return Object.prototype.hasOwnProperty.call(namespace,'module.exports')?namespace['module.exports']:namespace
    }
    const module={id:key,filename:key,path:key.slice(0,key.lastIndexOf('/'))||'/',exports:{},loaded:false,parent:parent??null,children:[]}
    module.require=createRequire(key,module,true)
    if(record.kind!=='builtin')cache[key]=module
    else loadingBuiltins.set(key,module)
    if(parent)parent.children.push(module)
    try{
      const loaded=loadSource(key)
      if(record.kind==='json')module.exports=JSON.parse(loaded.source.replace(/^\uFEFF/,''))
      else (record.kind==='builtin'?compileBuiltin(key):compileCommonJS(key,loaded.source)).call(module.exports,module.exports,module.require,module,key,module.path)
      // Optional owner-selected binding backend. Keep exports in the guest and
      // preserve the installed module's evaluation and CommonJS cache identity.
      if(record.kind==='commonjs'&&adaptExports)adaptExports(key,module.exports)
      module.loaded=true
      if(record.kind==='builtin'){
        module.exports=module.exports.default??module.exports
        builtins.set(key,module.exports)
        loadingBuiltins.delete(key)
      }
      return module.exports
    }catch(error){
      delete cache[key]
      loadingBuiltins.delete(key)
      if(parent){const index=parent.children.indexOf(module);if(index!==-1)parent.children.splice(index,1)}
      throw error
    }
  }
  function createRequire(filename,parent,internal=false){
    if(typeof filename==='object'&&filename!==null)filename=String(filename)
    if(typeof filename!=='string'||(!filename.startsWith('/')&&!filename.startsWith('file:')&&!(internal&&filename.startsWith('node:'))))throw new TypeError('createRequire requires an absolute filename or file URL')
    const require=specifier=>requireResolved(JSON.parse(hooks.resolve(specifier,filename,'require')),parent)
    require.resolve=specifier=>JSON.parse(hooks.resolve(specifier,filename,'require')).path
    require.cache=cache
    Object.defineProperty(require,'main',{get:()=>main})
    return require
  }
  function load(id){return requireResolved(JSON.parse(describe(id)))}
  function run(id){
    const record=JSON.parse(describe(id))
    // Set main before invoking the wrapper, including during cycles.
    const holder={id:record.path,filename:record.path,path:record.path.slice(0,record.path.lastIndexOf('/'))||'/',exports:{},loaded:false,parent:null,children:[]}
    main=holder;holder.require=createRequire(record.path,holder);cache[record.path]=holder
    try{
      if(record.kind==='json')holder.exports=JSON.parse(loadSource(record.path).source)
      else compileCommonJS(record.path,loadSource(record.path).source).call(holder.exports,holder.exports,holder.require,holder,holder.filename,holder.path)
      if(record.kind==='commonjs'&&adaptExports)adaptExports(record.path,holder.exports)
      holder.loaded=true;return holder.exports
    }catch(error){delete cache[record.path];throw error}
  }
  globalThis.__webContainerHost.modules={createRequire,load,run,registerHooks:hooks.registerHooks,resolve:hooks.resolve,loadSource,preloadModuleSources:hooks.preloadModuleSources}
})()
