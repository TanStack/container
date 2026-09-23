const {createPrimordials,factories}=require('./vendor/node24/inspection-generated.cjs')

// Call during trusted initialization, before guest application code can mutate
// intrinsics. The private engine binding never appears on the returned exports.
module.exports=function createNodeInspection(binding,dependencies){
  const primordials=createPrimordials()
  const cache=new primordials.SafeMap()
  const nativeUtil={...binding,constants:{ALL_PROPERTIES:0,ONLY_ENUMERABLE:2,kPending:0,kRejected:2}}
  const internalBinding=name=>{
    if(name==='util')return nativeUtil
    // QuickJS has no ICU engine. Node's own non-ICU width implementation is used.
    if(name==='config')return {hasIntl:false}
    throw new Error('Unsupported inspection native binding: '+name)
  }
  const load=name=>{
    if(name==='internal/util/types')return binding.types
    if(name==='internal/bootstrap/realm')return {BuiltinModule:{exists:dependencies.isBuiltin}}
    if(name==='internal/url')return dependencies.load('node:url')
    if(name==='buffer')return dependencies.load('node:buffer')
    if(cache.has(name))return cache.get(name).exports
    const factory=factories[name]
    if(!factory)throw new Error('Unsupported inspection module: '+name)
    const module={exports:{}}
    cache.set(name,module)
    try{factory(module,module.exports,load,primordials,internalBinding,dependencies.process)}
    catch(error){cache.delete(name);throw error}
    return module.exports
  }
  return load('internal/util/inspect')
}
