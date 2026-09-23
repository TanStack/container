export const callableLimits=Object.freeze({maxHandles:32,maxPending:64,maxBundlerCallbacks:256,maxCallbackBytes:65536,maxWorkspaceBytes:256*1024*1024,maxWorkspaceFiles:32768})
export const callableCallbackNames=['resolveSubpathImports','onWarn','onDebug','finalizeBareSpecifier','finalizeOtherSpecifiers'] as const
export function validateCallableHookArguments(method:string,args:unknown[]):void{
  if(!Array.isArray(args))throw Error('Invalid callable hook arguments')
  if(method==='load'){
    // The native binding accepts id; Vite's plugin container also forwards its
    // {ssr:boolean} hook options. Preserve that real extra argument unchanged.
    const options=args[1]
    if((args.length!==1&&args.length!==2)||typeof args[0]!=='string'||args.length===2&&(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='ssr')||typeof (options as {ssr?:unknown}).ssr!=='boolean'))throw Error('Invalid load arguments')
    return
  }
  if(method==='transform'){
    if(args.length!==3||typeof args[0]!=='string'||typeof args[1]!=='string'||!args[2]||typeof args[2]!=='object'||Array.isArray(args[2]))throw Error('Invalid transform arguments')
    return
  }
  throw Error('Unsupported callable hook')
}
export function callableWorkspaceLimits(maxBytes:number,maxFiles:number){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>callableLimits.maxWorkspaceBytes||!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>callableLimits.maxWorkspaceFiles)throw Error('Invalid callable workspace limits')
  return {maxBytes,maxFiles}
}
/** Tagged values are data only. Functions are supplied by the owner bridge. */
export function restoreCallableDescriptor(value:unknown,callback:(method:string,args:unknown[])=>unknown):any{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid callable descriptor')
  const descriptor=value as Record<string,unknown>
  const name=descriptor.__name
  if(!['builtin:vite-resolve','builtin:oxc-runtime','builtin:vite-json','builtin:vite-react-refresh-wrapper'].includes(name as string)||Object.keys(descriptor).some(key=>!['__name','options'].includes(key)))throw Error('Unsupported callable builtin')
  if(name==='builtin:oxc-runtime'){
    if(descriptor.options!==undefined)throw Error('Unsupported oxc runtime options')
    return {__name:name,options:undefined}
  }
  if(!descriptor.options||typeof descriptor.options!=='object'||Array.isArray(descriptor.options))throw Error('Invalid callable options')
  if(name==='builtin:vite-json'){
    const options=descriptor.options as Record<string,unknown>
    if(Object.keys(options).some(key=>!['namedExports','stringify','minify'].includes(key))||['namedExports','minify'].some(key=>options[key]!==undefined&&typeof options[key]!=='boolean')||options.stringify!==undefined&&typeof options.stringify!=='boolean'&&options.stringify!=='auto')throw Error('Invalid Vite JSON options')
  }
  let count=0
  function restore(item:any,depth:number,option?:string):any{
    if(++count>8192||depth>32)throw Error('Callable descriptor exceeds limits')
    if(typeof item==='string'&&new TextEncoder().encode(item).byteLength>callableLimits.maxCallbackBytes)throw Error('Callable descriptor string exceeds byte ceiling')
    if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item)||item===undefined)return item
    if(typeof item!=='object')throw Error('Unsupported callable descriptor value')
    if(Array.isArray(item))return item.map(value=>restore(value,depth+1))
    if(item.type==='callback'){
      if(name!=='builtin:vite-resolve'||Object.keys(item).length!==1||!(callableCallbackNames as readonly string[]).includes(option??''))throw Error('Unsupported callable callback tag')
      return (...args:unknown[])=>callback(option!,args)
    }
    if(item.type==='RegExp'){
      if(Object.keys(item).sort().join(',')!=='flags,source,type'||typeof item.source!=='string'||typeof item.flags!=='string')throw Error('Invalid callable RegExp tag')
      return new RegExp(item.source,item.flags)
    }
    return Object.fromEntries(Object.entries(item).map(([key,value])=>[key,restore(value,depth+1)]))
  }
  const restored={__name:descriptor.__name,options:Object.fromEntries(Object.entries(descriptor.options).map(([key,value])=>[key,restore(value,0,key)]))}
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>callableLimits.maxCallbackBytes)throw Error('Callable descriptor exceeds byte ceiling')
  return restored
}
