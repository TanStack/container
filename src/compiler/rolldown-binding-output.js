const chunkMethods=['getFileName','getName','getExports','getIsEntry','getFacadeModuleId','getIsDynamicEntry','getSourcemapFileName','getPreliminaryFileName','getCode','getModules','getImports','getDynamicImports','getModuleIds','getMap']
const assetMethods=['getFileName','getOriginalFileName','getOriginalFileNames','getSource','getName','getNames']

// Materialize native getters while their compiler session is still alive.
export function snapshotBindingResult(result){
  if(result?.isBindingErrors)return result
  if(!result||!Array.isArray(result.chunks)||!Array.isArray(result.assets))throw Error('Unsupported Rolldown binding output')
  const snapshot=(item,methods)=>Object.fromEntries(methods.map(name=>{
    if(typeof item[name]!=='function')throw Error('Missing Rolldown output getter: '+name)
    const value=item[name]()
    return [name,name==='getModules'?{keys:[...value.keys],values:value.values.map(module=>({code:module.code,renderedExports:[...module.renderedExports]}))}:value]
  }))
  return {...result,chunks:result.chunks.map(item=>snapshot(item,chunkMethods)),assets:result.assets.map(item=>snapshot(item,assetMethods))}
}

// Use a tagged tree, not ambiguous tags mixed with user object properties.
// JSON alone loses undefined, typed bytes and Error details.
export function encodeBindingSnapshot(value,maxBytes=16*1024*1024){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('Invalid output byte limit')
  const ancestors=new Set()
  function encode(value,depth){
    if(depth>64)throw Error('Binding output nesting limit')
    if(value===undefined)return ['undefined']
    if(value===null||typeof value==='string'||typeof value==='boolean')return ['value',value]
    if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Unsupported binding output number');return ['value',value]}
    if(typeof value!=='object')throw Error('Unsupported binding output value')
    if(ancestors.has(value))throw Error('Cyclic binding output')
    ancestors.add(value)
    try{
      if(value instanceof Uint8Array)return ['bytes',Array.from(value)]
      if(Array.isArray(value))return ['array',value.map(item=>encode(item,depth+1))]
      const properties=value instanceof Error
        ?{...value,name:value.name,message:value.message,stack:value.stack,...('cause'in value?{cause:value.cause}:{})}
        :value
      if(!(value instanceof Error)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Unsupported native output object')
      return [value instanceof Error?'error':'object',Object.entries(properties).map(([key,item])=>[key,encode(item,depth+1)])]
    }finally{ancestors.delete(value)}
  }
  const encoded=encode(value,0)
  if(new TextEncoder().encode(JSON.stringify(encoded)).byteLength>maxBytes)throw Error('Binding output exceeds owner byte limit')
  return encoded
}

// Closure-free so the same implementation can execute inside the guest VM.
export function restoreGuestBindingResult(encoded){
  function decode(node,depth=0){
    if(depth>64||!Array.isArray(node))throw Error('Invalid binding output transport')
    const [type,value]=node
    if(type==='undefined')return undefined
    if(type==='value')return value
    if(type==='bytes')return new Uint8Array(value)
    if(type==='array')return value.map(item=>decode(item,depth+1))
    if(type!=='object'&&type!=='error')throw Error('Unknown binding output transport tag')
    const result=type==='error'?new Error():{}
    for(const [key,item]of value)Object.defineProperty(result,key,{value:decode(item,depth+1),enumerable:true,configurable:true,writable:true})
    return result
  }
  const result=decode(encoded)
  if(result?.isBindingErrors)return result
  if(!result||!Array.isArray(result.chunks)||!Array.isArray(result.assets))throw Error('Invalid binding output snapshot')
  function restore(snapshot){
    const object={}
    let values=snapshot
    for(const name of Object.keys(snapshot))Object.defineProperty(object,name,{value:()=>{
      if(!values)throw Object.assign(new Error('Memory has been freed by `freeExternalMemory()`. Cannot access properties. To prevent this, use `freeExternalMemory(handle, true)` with `keepDataAlive`.'),{code:'GenericFailure'})
      return values[name]
    },enumerable:true})
    Object.defineProperty(object,'dropInner',{value:()=>{
      if(!values)return {freed:false,reason:'Memory has already been freed'}
      values=null
      return {freed:true}
    },enumerable:true})
    return object
  }
  return {...result,chunks:result.chunks.map(restore),assets:result.assets.map(restore)}
}
