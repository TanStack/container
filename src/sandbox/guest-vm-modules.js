export function createVMModules(rootAPI,contextAPI){
const modules=new WeakMap()
const namespaces=new WeakMap()
const statusError=message=>Object.assign(Error(message),{code:'ERR_VM_MODULE_STATUS'})
let pendingImports=0
function importCallback(callback,referrer,context){
  if(callback!==undefined&&typeof callback!=='function')invalid('Expected importModuleDynamically function')
  return async(specifier,attributes)=>{
    if(!callback)throw Object.assign(Error('Missing dynamic import callback'),{code:'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING'})
    if(pendingImports>=32)throw new RangeError('VM pending import limit')
    pendingImports++
    try{
      const module=await callback(specifier,referrer,attributes??Object.create(null))
      if(modules.get(referrer)?.status==='disposed')throw Error('Importing module is disposed')
      const namespaceOwner=namespaces.get(module)
      if(namespaceOwner){
        if(namespaceOwner.context!==context)throw Object.assign(Error('Module context differs'),{code:'ERR_VM_MODULE_DIFFERENT_CONTEXT'})
        if(namespaceOwner.status==='disposed')throw statusError('Module is disposed')
        return module
      }
      const s=modules.get(module)
      if(!s)throw Object.assign(new TypeError('Dynamic import must return a VM module'),{code:'ERR_VM_MODULE_NOT_MODULE'})
      if(s.context!==context)throw Object.assign(Error('Module context differs'),{code:'ERR_VM_MODULE_DIFFERENT_CONTEXT'})
      if(modules.get(referrer)?.status==='disposed')throw Error('Importing module is disposed')
      if(!['linked','evaluating','evaluated','errored'].includes(module.status))throw Object.assign(Error('Module is not linked'),{code:'ERR_VM_MODULE_STATUS'})
      if(module.status==='errored')throw module.error
      return module.namespace
    }finally{pendingImports--}
  }
}
const invalid=message=>{throw new TypeError(message)}
function state(module){return modules.get(module)??invalid('Invalid VM module receiver')}
function settings(options){
  for(const key of Object.keys(options))if(!['identifier','initializeImportMeta','context','importModuleDynamically'].includes(key))throw Object.assign(Error('Unsupported VM module option '+key),{code:'ERR_UNSUPPORTED_OPERATION'})
  return options
}
class VMModule {
  get status(){const s=state(this);return ['linking','errored','disposed'].includes(s.status)?s.status:s.api.status(s.handle)}
  get identifier(){return state(this).identifier}
  get context(){return state(this).context}
  get namespace(){const s=state(this);if(s.linkFailed||!['linked','evaluated','evaluating','errored'].includes(this.status))throw statusError('Module is not linked');const namespace=s.api.namespace(s.handle);namespaces.set(namespace,s);return namespace}
  get error(){const s=state(this);if(this.status!=='errored')throw statusError('Module has no error');return s.status==='errored'?s.error:s.api.error(s.handle)}
  async link(linker){
    const root=state(this),seen=new Set(),ordered=[]
    let synchronousFailure=false
    if(root.status!=='unlinked')invalid('Module is not unlinked')
    const collect=async module=>{
      const s=state(module)
      if(seen.has(module)||s.status==='linked'||s.status==='evaluated')return
      if(s.status!=='unlinked')invalid('Module graph is already linking')
      seen.add(module);ordered.push(module);s.status='linking'
      for(const name of s.api.requests(s.handle)){
        let result
        try{result=linker(name,module)}catch(error){synchronousFailure=true;throw error}
        const dependency=await result,target=state(dependency)
        if(target.context!==s.context)throw Object.assign(Error('Module context differs'),{code:'ERR_VM_MODULE_DIFFERENT_CONTEXT'})
        s.dependencies.push(dependency);s.api.edge(s.handle,name,target.handle)
        await collect(dependency)
      }
    }
    try{await collect(this);root.api.link(root.handle);for(const module of ordered)state(module).status='linked'}
    catch(error){for(const module of ordered){const s=state(module);s.linkFailed=true;if(!synchronousFailure){s.status='errored';s.error=error}}throw error}
  }
  async evaluate(options={}){
    if(Object.keys(options).length)throw Object.assign(Error('VM evaluation options are not supported by this spike'),{code:'ERR_UNSUPPORTED_OPERATION'})
    const s=state(this)
    if(this.status==='errored')throw this.error
    if(this.status==='evaluated')return
    if(this.status!=='linked')invalid('Module is not linked')
    const seen=new Set()
    const prepare=module=>{
      if(seen.has(module))return;seen.add(module)
      const entry=state(module)
      for(const dependency of entry.dependencies)prepare(dependency)
      if(!entry.metaInitialized){entry.metaInitialized=true;entry.meta?.(entry.api.meta(entry.handle),module)}
    }
    try{prepare(this);s.status='evaluating';await s.api.evaluate(s.handle);for(const module of seen)state(module).status='evaluated'}
    catch(error){s.status='errored';s.error=error;throw error}
  }
  dispose(){const s=state(this);if((s.status==='linking'&&!s.linkFailed)||s.status==='evaluating')invalid('Module is busy');if(s.status==='disposed')return;s.api.dispose(s.handle);s.status='disposed';s.dependencies=[]}
}
class SourceTextModule extends VMModule {
  constructor(source,options={}){
    super();settings(options)
    const api=options.context===undefined?rootAPI:contextAPI(options.context)
    if(!api)throw Object.assign(Error('VM modules require an opt-in engine'),{code:'ERR_UNSUPPORTED_OPERATION'})
    const hook=importCallback(options.importModuleDynamically,this,options.context)
    modules.set(this,{api,handle:api.create(String(source),undefined),context:options.context,identifier:options.identifier??'anonymous',status:'unlinked',dependencies:[],meta:options.initializeImportMeta})
    api.importCallback(state(this).handle,hook)
  }
}
class SyntheticModule extends VMModule {
  constructor(names,evaluate,options={}){
    super();settings(options)
    const api=options.context===undefined?rootAPI:contextAPI(options.context)
    if(!api)throw Object.assign(Error('VM modules require an opt-in engine'),{code:'ERR_UNSUPPORTED_OPERATION'})
    if(!Array.isArray(names)||names.some(name=>typeof name!=='string')||new Set(names).size!==names.length||typeof evaluate!=='function')invalid('Invalid synthetic module')
    modules.set(this,{api,handle:api.create(names,()=>evaluate.call(this)),context:options.context,identifier:options.identifier??'anonymous',status:'unlinked',dependencies:[],names:new Set(names)})
  }
  setExport(name,value){const s=state(this);if(!s.names.has(name))invalid('Unknown export');if(!['linked','evaluating','evaluated'].includes(s.status))invalid('Module is not linked');s.api.setExport(s.handle,name,value)}
}

return {SourceTextModule,SyntheticModule,importCallback}
}
