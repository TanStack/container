/** Trusted guest factory. Keeps real synchronous construction and getOrder. */
export function createGuestCallableAdapter(Original,dispatch,host){
  function BindingCallableBuiltinPlugin(descriptor){
    const original=new Original(descriptor)
    if(!['builtin:vite-resolve','builtin:oxc-runtime','builtin:vite-json','builtin:vite-react-refresh-wrapper'].includes(descriptor?.__name))throw Object.assign(new Error(`Rolldown callable ${descriptor?.__name??'<unknown>'} is not supported by the browser native service`),{code:'ERR_UNSUPPORTED_OPERATION'})
    const callbacks={}
    function encode(value,key){
      if(typeof value==='function'){callbacks[key]=value;return {type:'callback'}}
      if(value instanceof RegExp)return {type:'RegExp',source:value.source,flags:value.flags}
      if(Array.isArray(value))return value.map(item=>encode(item))
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,encode(item,name)]))
      return value
    }
    const encoded=encode(descriptor),handle=dispatch.register(callbacks)
    try{
      const hooks=[];for(const name in original)hooks.push({name,order:original.getOrder(name)})
      host.register(handle,encoded,hooks)
      for(const name of ['resolveId','load','transform','watchChange']){
        if(typeof original[name]!=='function')continue
        Object.defineProperty(original,name,{enumerable:true,configurable:true,writable:true,value:function(...args){return dispatch.invoke(handle,name,args)}})
      }
      return original
    }catch(error){dispatch.release(handle);host.release?.(handle);throw error}
  }
  Object.setPrototypeOf(BindingCallableBuiltinPlugin,Original)
  BindingCallableBuiltinPlugin.prototype=Original.prototype
  return BindingCallableBuiltinPlugin
}
