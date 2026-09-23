// Trusted replacement for the exact, hash-pinned Rolldown 1.2.9 WASI binding.
// The real compiler lives in the owner worker. Keeping this object in the guest
// preserves Rolldown's import shape without instantiating its 1 GiB WASI memory.
export function createRolldownGuestBinding(target={},sync){
  const unsupported=name=>{
    const fail=function(){throw Object.assign(new Error(`Rolldown binding export ${name} is not supported by the browser native service`),{code:'ERR_UNSUPPORTED_OPERATION'})}
    Object.defineProperty(fail,'name',{value:name,configurable:true})
    return fail
  }
  const enumObject=values=>{
    const value={}
    for(const [name,item] of Object.entries(values))Object.defineProperty(value,name,{value:item,enumerable:false,writable:false,configurable:false})
    return Object.freeze(value)
  }
  const enums={
    BindingLogLevel:{Silent:0,Warn:1,Info:2,Debug:3},
    BindingErrorStage:{Hmr:'Hmr',Rebuild:'Rebuild'},
    BindingRebuildStrategy:{Always:0,Never:1},
    BindingPropertyReadSideEffects:{Always:0,False:1},
    BindingPropertyWriteSideEffects:{Always:0,False:1},
    BindingAttachDebugInfo:{None:0,Simple:1,Full:2},
    BindingChunkModuleOrderBy:{ModuleId:0,ExecOrder:1},
    BindingPluginOrder:{Pre:0,Post:1},
    FilterTokenKind:{Id:'Id',ImporterId:'ImporterId',Code:'Code',ModuleType:'ModuleType',And:'And',Or:'Or',Not:'Not',Include:'Include',Exclude:'Exclude',CleanUrl:'CleanUrl',QueryKey:'QueryKey',QueryValue:'QueryValue'},
    BindingBuiltinPluginName:{BundleAnalyzer:'builtin:bundle-analyzer',EsmExternalRequire:'builtin:esm-external-require',IsolatedDeclaration:'builtin:isolated-declaration',Replace:'builtin:replace',ViteAlias:'builtin:vite-alias',ViteBuildImportAnalysis:'builtin:vite-build-import-analysis',ViteDynamicImportVars:'builtin:vite-dynamic-import-vars',ViteImportGlob:'builtin:vite-import-glob',ViteJson:'builtin:vite-json',ViteLoadFallback:'builtin:vite-load-fallback',ViteManifest:'builtin:vite-manifest',ViteModulePreloadPolyfill:'builtin:vite-module-preload-polyfill',ViteReactRefreshWrapper:'builtin:vite-react-refresh-wrapper',ViteReporter:'builtin:vite-reporter',ViteResolve:'builtin:vite-resolve',ViteTransform:'builtin:vite-transform',ViteWebWorkerPost:'builtin:vite-web-worker-post',OxcRuntime:'builtin:oxc-runtime'},
    LegalCommentsMode:{None:'none',Inline:'inline',Eof:'eof',External:'external'},
    ModuleType:{Module:'module',CommonJs:'commonjs',Json:'json',Wasm:'wasm',Addon:'addon'},
    EnforceExtension:{Auto:0,Enabled:1,Disabled:2},
    ImportNameKind:{Name:'Name',NamespaceObject:'NamespaceObject',Default:'Default'},
    ExportLocalNameKind:{Name:'Name',Default:'Default',None:'None'},
    ExportExportNameKind:{Name:'Name',Default:'Default',None:'None'},
    ExportImportNameKind:{Name:'Name',All:'All',AllButDefault:'AllButDefault',None:'None'},
    HelperMode:{Runtime:'Runtime',External:'External'},
    Severity:{Error:'Error',Warning:'Warning',Advice:'Advice'},
  }
  for(const [name,value] of Object.entries(enums))target[name]=enumObject(value)

  function BindingCallableBuiltinPlugin(descriptor){
    const name=descriptor?.__name
    if(!['builtin:vite-resolve','builtin:oxc-runtime','builtin:vite-json','builtin:vite-react-refresh-wrapper'].includes(name))throw Object.assign(new Error(`Rolldown callable ${name??'<unknown>'} is not supported by the browser native service`),{code:'ERR_UNSUPPORTED_OPERATION'})
    Object.defineProperty(this,'descriptor',{value:descriptor,writable:false,configurable:false})
  }
  BindingCallableBuiltinPlugin.prototype.getOrder=function(name){const plugin=this.descriptor?.__name;return plugin==='builtin:oxc-runtime'&&(name==='load'||name==='resolveId')||plugin==='builtin:vite-react-refresh-wrapper'&&name==='resolveId'?'pre':null}
  for(const name of ['load','resolveId','transform','watchChange'])BindingCallableBuiltinPlugin.prototype[name]=unsupported(`BindingCallableBuiltinPlugin.${name}`)
  target.BindingCallableBuiltinPlugin=BindingCallableBuiltinPlugin

  function BindingMagicString(){throw Object.assign(new Error('Rolldown native MagicString is not supported by the browser native service'),{code:'ERR_UNSUPPORTED_OPERATION'})}
  for(const name of ['append','appendLeft','appendRight','clone','filename','generateDecodedMap','generateMap','getIndentString','hasChanged','ignoreList','indent','indentExclusionRanges','insert','isEmpty','lastChar','lastLine','length','move','offset','original','overwrite','prepend','prependLeft','prependRight','relocate','remove','replace','replaceAll','replaceRegex','reset','slice','snip','toString','trim','trimEnd','trimLines','trimStart','update'])BindingMagicString.prototype[name]=unsupported(`BindingMagicString.${name}`)
  target.BindingMagicString=BindingMagicString

  function TsconfigCache(yarnPnp,pathToTsconfig){
    if(!sync)throw Object.assign(new Error('Rolldown synchronous compiler service is unavailable'),{code:'ERR_UNSUPPORTED_OPERATION'})
    Object.defineProperty(this,'__nativeHandle',{value:sync.createTsconfigCache(pathToTsconfig),writable:false,configurable:false})
  }
  TsconfigCache.prototype.clear=function(){return sync.clearTsconfigCache(this.__nativeHandle)}
  TsconfigCache.prototype.size=function(){return sync.tsconfigCacheSize(this.__nativeHandle)}
  target.TsconfigCache=TsconfigCache
  target.enhancedTransformSync=(filename,source,options,cache)=>sync.transformSync(filename,source,options,cache?.__nativeHandle)
  target.parseSync=(filename,source,options)=>sync.parseSync(filename,source,options)

  // Tracing is optional in Rolldown. Returning no guard is its documented
  // disabled state and lets the public module initialize without a native tracer.
  target.initTraceSubscriber=()=>undefined
  const unsupportedNames=['__internalForcePanic','getNativeMemoryStats','resetNativeMemoryStats','registerPlugins','resolveTsconfig','enhancedTransform','collapseSourcemaps','minify','minifySync','sync','rawTransferSupported','parseRaw','parseRawSync','getBufferOffset','transform','transformSync','moduleRunnerTransform','moduleRunnerTransformSync','isolatedDeclaration','isolatedDeclarationSync','BindingWatcherEvent','BindingBundleErrorEventData','ResolverFactory','BindingLoadPluginContext','ResolveDtsTask','BindingRenderedChunkMeta','BindingSourceMap','BindingTransformPluginContext','ModuleRunnerTransformTask','BindingRenderedModule','BindingChunkingContext','EnhancedTransformTask','ParseResult','TransformTask','ParallelJsPluginRegistry','BindingPluginContext','BindingWatcher','BindingOutputChunk','BindingRenderedChunk','MinifyTask','IsolatedDeclarationTask','BindingDecodedMap','BindingDevEngine','ResolveTask','BindingWatcherBundler','BindingOutputAsset','ResolveFileTask','BindingWatcherChangeData','TraceSubscriberGuard','BindingBundleEndEventData','BindingModuleInfo','BindingNormalizedOptions']
  for(const name of unsupportedNames)target[name]=unsupported(name)
  target.__napiBindingTarget='wasm32-wasi'
  return target
}
