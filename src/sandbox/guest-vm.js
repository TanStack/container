import {createVMModules} from './guest-vm-modules.js'
const invalid=(message,code='ERR_INVALID_ARG_TYPE')=>Object.assign(new TypeError(message),{code})
const unsupported=()=>{throw Object.assign(new Error('This vm operation is not implemented in the guest'),{code:'ERR_UNSUPPORTED_OPERATION'})}
const compiled=new WeakMap()
const contexts=new WeakMap()
function options(value){
  if(typeof value==='string')return {filename:value}
  if(value===undefined)return {}
  if(value===null||typeof value!=='object')throw invalid('Expected script options')
  return value
}
function integer(value,name,min,max){
  if(typeof value!=='number')throw invalid('Expected numeric '+name)
  if(!Number.isInteger(value)||value<min||value>max)throw Object.assign(new RangeError(name+' is out of range'),{code:'ERR_OUT_OF_RANGE'})
  return value
}
function executionOptions(value){
  const o=options(value)
  if(o.displayErrors!==undefined&&typeof o.displayErrors!=='boolean')throw invalid('Expected boolean displayErrors')
  if(o.breakOnSigint!==undefined&&typeof o.breakOnSigint!=='boolean')throw invalid('Expected boolean breakOnSigint')
  if(o.breakOnSigint===true)unsupported()
  return o.timeout===undefined?0:integer(o.timeout,'timeout',1,2147483647)
}
function contextOptions(value){
  if(value===undefined)return {}
  if(value===null||typeof value!=='object')throw invalid('Expected context options')
  for(const key of ['name','origin'])if(value[key]!==undefined&&typeof value[key]!=='string')throw invalid('Expected a string '+key)
  if(value.microtaskMode!==undefined)unsupported()
  const generation=value.codeGeneration
  if(generation!==undefined){
    if(generation===null||typeof generation!=='object')throw invalid('Expected codeGeneration options')
    for(const key of ['strings','wasm'])if(generation[key]!==undefined&&typeof generation[key]!=='boolean')throw invalid('Expected boolean codeGeneration.'+key)
  }
  return value
}
export function createContext(sandbox={},value){
  if(sandbox===null||typeof sandbox!=='object')throw invalid('Expected a sandbox object')
  const o=contextOptions(value)
  if(contexts.has(sandbox))return sandbox
  const create=globalThis.__webContainerHost?.createContext
  if(typeof create!=='function')unsupported()
  contexts.set(sandbox,create(sandbox,o.codeGeneration?.strings!==false))
  return sandbox
}
export function isContext(value){
  if(value===null||typeof value!=='object')throw invalid('Expected an object')
  return contexts.has(value)
}
export class Script {
  constructor(code='',value){
    code=String(code)
    const o=options(value),filename=o.filename===undefined?'evalmachine.<anonymous>':o.filename
    if(typeof filename!=='string')throw invalid('Expected a filename string')
    if(filename.includes('\0'))throw invalid('Filename contains a null byte','ERR_INVALID_ARG_VALUE')
    for(const key of ['cachedData','parsingContext'])if(o[key]!==undefined)unsupported()
    if(o.importModuleDynamically!==undefined&&!globalThis.__webContainerHost?.vmModules)unsupported()
    if(o.produceCachedData===true)unsupported()
    if(o.displayErrors!==undefined&&typeof o.displayErrors!=='boolean')throw invalid('Expected boolean displayErrors')
    const line=integer(o.lineOffset===undefined?0:o.lineOffset,'lineOffset',-1000000,1000000)
    const column=integer(o.columnOffset===undefined?0:o.columnOffset,'columnOffset',-1000000,1000000)
    const compile=globalThis.__webContainerHost.compileScript
    if(typeof compile!=='function')unsupported()
    const args=[code,filename,line,column]
    const callback=o.importModuleDynamically
    compiled.set(this,{args,callback,run:compile(...args,callback===undefined?undefined:vmModules.importCallback(callback,this,undefined)),contexts:new WeakMap()})
  }
  runInThisContext(value){
    const script=compiled.get(this)
    if(!script)throw invalid('Expected a Script receiver')
    return script.run(executionOptions(value))
  }
  runInContext(sandbox,value){
    const script=compiled.get(this)
    if(!script)throw invalid('Expected a Script receiver')
    const compile=contexts.get(sandbox)
    if(!compile)throw invalid('Expected a contextified sandbox')
    const timeout=executionOptions(value)
    let run=script.contexts.get(compile)
    if(!run){run=compile(...script.args,script.callback===undefined?undefined:vmModules.importCallback(script.callback,this,sandbox));script.contexts.set(compile,run)}
    return run(timeout)
  }
  runInNewContext(sandbox,value){
    const o=options(value)
    return this.runInContext(createContext(sandbox,{name:o.contextName,origin:o.contextOrigin,codeGeneration:o.contextCodeGeneration,microtaskMode:o.microtaskMode}),o)
  }
  createCachedData(){return unsupported()}
}
export const createScript=(code,value)=>new Script(code,value)
export function runInThisContext(code,value){return new Script(code,value).runInThisContext(value)}
export function runInContext(code,sandbox,value){return new Script(code,value).runInContext(sandbox,value)}
export function runInNewContext(code,sandbox,value){return new Script(code,value).runInNewContext(sandbox,value)}
export const compileFunction=unsupported,measureMemory=unsupported
const vmModules=createVMModules(globalThis.__webContainerHost?.vmModules,sandbox=>{
  const compile=contexts.get(sandbox)
  if(!compile)throw invalid('Expected a contextified sandbox')
  return compile.vmModules
})
export const {SyntheticModule,SourceTextModule}=vmModules
export default {Script,createScript,runInThisContext,createContext,runInContext,runInNewContext,compileFunction,measureMemory,isContext,SyntheticModule,SourceTextModule}
