// Isolated API spike. The production node:vm exports are unchanged.
const modules=new WeakMap()
const invalid=message=>{throw new TypeError(message)}
function state(module){return modules.get(module)??invalid('Invalid VM module receiver')}
function settings(options){
  for(const key of Object.keys(options))if(!['identifier','initializeImportMeta'].includes(key))throw Object.assign(Error('Unsupported VM module option '+key),{code:'ERR_UNSUPPORTED_OPERATION'})
  return options
}
class VMModule {
  get status(){return state(this).status}
  get identifier(){return state(this).identifier}
  get namespace(){const s=state(this);if(!['linked','evaluated','evaluating'].includes(s.status))invalid('Module is not linked');return vmNative.namespace(s.handle)}
  get error(){const s=state(this);if(s.status!=='errored')invalid('Module has no error');return s.error}
  async link(linker){
    const root=state(this),seen=new Set(),ordered=[]
    if(root.status!=='unlinked')invalid('Module is not unlinked')
    const collect=async module=>{
      const s=state(module)
      if(seen.has(module)||s.status==='linked'||s.status==='evaluated')return
      if(s.status!=='unlinked')invalid('Module graph is already linking')
      seen.add(module);ordered.push(module);s.status='linking'
      for(const name of vmNative.requests(s.handle)){
        const dependency=await linker(name,module),target=state(dependency)
        s.dependencies.push(dependency);vmNative.edge(s.handle,name,target.handle)
        await collect(dependency)
      }
    }
    try{await collect(this);vmNative.link(root.handle);for(const module of ordered)state(module).status='linked'}
    catch(error){for(const module of ordered){const s=state(module);s.status='errored';s.error=error}throw error}
  }
  async evaluate(options={}){
    if(Object.keys(options).length)throw Object.assign(Error('VM evaluation options are not supported by this spike'),{code:'ERR_UNSUPPORTED_OPERATION'})
    const s=state(this)
    if(s.status==='errored')throw s.error
    if(s.status==='evaluated')return
    if(s.status!=='linked')invalid('Module is not linked')
    const seen=new Set()
    const prepare=module=>{
      if(seen.has(module))return;seen.add(module)
      const entry=state(module)
      for(const dependency of entry.dependencies)prepare(dependency)
      if(!entry.metaInitialized){entry.metaInitialized=true;entry.meta?.(vmNative.meta(entry.handle),module)}
    }
    try{prepare(this);s.status='evaluating';await vmNative.evaluate(s.handle);for(const module of seen)state(module).status='evaluated'}
    catch(error){s.status='errored';s.error=error;throw error}
  }
  dispose(){const s=state(this);if(s.status==='linking'||s.status==='evaluating')invalid('Module is busy');if(s.status==='disposed')return;vmNative.dispose(s.handle);s.status='disposed';s.dependencies=[]}
}
class SourceTextModule extends VMModule {
  constructor(source,options={}){
    super();settings(options)
    modules.set(this,{handle:vmNative.create(String(source),undefined),identifier:options.identifier??'anonymous',status:'unlinked',dependencies:[],meta:options.initializeImportMeta})
  }
}
class SyntheticModule extends VMModule {
  constructor(names,evaluate,options={}){
    super();settings(options)
    if(!Array.isArray(names)||names.some(name=>typeof name!=='string')||new Set(names).size!==names.length||typeof evaluate!=='function')invalid('Invalid synthetic module')
    modules.set(this,{handle:vmNative.create(names,()=>evaluate.call(this)),identifier:options.identifier??'anonymous',status:'unlinked',dependencies:[],names:new Set(names)})
  }
  setExport(name,value){const s=state(this);if(!s.names.has(name))invalid('Unknown export');if(!['linked','evaluating','evaluated'].includes(s.status))invalid('Module is not linked');vmNative.setExport(s.handle,name,value)}
}
