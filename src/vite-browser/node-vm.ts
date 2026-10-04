import browserVm from 'vm-browserify'
import {workerSourceLocations,browserSourceLocationsEnabled} from '../native/browser-source-locations'
import {browserInlineSourceMap} from '../native/browser-inline-source-map'
import {TraceMap,originalPositionFor} from '@jridgewell/trace-mapping'
import {transformNodeReturns} from '../native/node-return-transform'
import {createClassicVmScript} from '../native/classic-vm-script'

interface ScriptOptions{filename?:string;lineOffset?:number;columnOffset?:number;[key:string]:unknown}
let scriptIdentity=0

function validateExecutionOptions(options:unknown){
  if(options===undefined)return
  const invalid=(name:string)=>Object.assign(new TypeError(`${name} must have the expected type`),{code:'ERR_INVALID_ARG_TYPE'})
  if(options===null||typeof options!=='object')throw invalid('options')
  const values=options as Record<string,unknown>
  if(values.timeout!==undefined){
    if(typeof values.timeout!=='number')throw invalid('options.timeout')
    if(!Number.isInteger(values.timeout)||values.timeout<1||values.timeout>4294967295)
      throw Object.assign(new RangeError('options.timeout must be an integer from 1 to 4294967295'),{code:'ERR_OUT_OF_RANGE'})
  }
  if(values.breakOnSigint!==undefined&&typeof values.breakOnSigint!=='boolean')throw invalid('options.breakOnSigint')
  if(values.timeout!==undefined||values.breakOnSigint===true)
    throw Object.assign(new Error('VM execution timeout and signal interruption are not supported by the browser runtime'),{code:'ERR_NOT_IMPLEMENTED'})
}

function validateScriptOptions(options:unknown){
  const invalid=(name:string)=>Object.assign(new TypeError(`${name} must have the expected type`),{code:'ERR_INVALID_ARG_TYPE'})
  if(options===undefined||typeof options==='string')return
  if(options===null||typeof options!=='object')throw invalid('options')
  const values=options as ScriptOptions
  if(values.filename!==undefined&&typeof values.filename!=='string')throw invalid('options.filename')
  for(const name of ['lineOffset','columnOffset'] as const){
    const value=values[name]
    if(value===undefined)continue
    if(typeof value!=='number')throw invalid(`options.${name}`)
    if(!Number.isInteger(value)||value< -2147483648||value>2147483647)
      throw Object.assign(new RangeError(`options.${name} must be a signed 32-bit integer`),{code:'ERR_OUT_OF_RANGE'})
  }
}

/** Keep evaluated filenames in browser stacks, as Node's Script does. */
function scriptSource(code:unknown,options?:ScriptOptions|string):string{
  validateScriptOptions(options)
  const filename=typeof options==='string'?options:options?.filename
  if(filename===undefined)return String(code)
  if(/[\r\n\u2028\u2029]/.test(filename))throw new TypeError('Script filename cannot contain a line break')
  if(browserSourceLocationsEnabled()){
    const source=String(code)
    const lineOffset=typeof options==='object'?options.lineOffset??0:0
    const columnOffset=typeof options==='object'?options.columnOffset??0:0
    const map=browserInlineSourceMap(source)
    const trace=(globalThis as typeof globalThis & {process?:{env?:Record<string,string|undefined>}}).process?.env?.NATIVE_VM_SOURCE_TRACE
    if(trace===filename)console.error('VM_SOURCE_LOCATION',JSON.stringify({filename,lineOffset,columnOffset,map:Boolean(map),mapData:map&&{version:(map as any).version,mappings:(map as any).mappings?.slice(0,300),sources:(map as any).sources},source:source.slice(0,700),tail:source.slice(-250)}))
    const traced=map?new TraceMap(map as any):undefined
    const lowered=transformNodeReturns(source,filename)
    const url=`${filename}?native-vm-script=${++scriptIdentity}`
    const loweredMap=new TraceMap(lowered.map as any)
    workerSourceLocations.register(url,(line,column)=>{
      const input=originalPositionFor(loweredMap,{line,column:column-1})
      if(input.line===null||input.column===null)return null
      const adjustedLine=input.line+lineOffset,adjustedColumn=input.column+1+(input.line===1?columnOffset:0)
      if(adjustedLine<1||adjustedColumn<1)return null
      if(!traced)return {file:filename,line:adjustedLine,column:adjustedColumn}
      const original=originalPositionFor(traced,{line:adjustedLine,column:adjustedColumn-1})
      if(trace===filename)console.error('VM_POSITION',JSON.stringify({line,column,adjustedLine,adjustedColumn,original}))
      if(original.source===null||original.line===null||original.column===null)return null
      const base=new URL('file:///');base.pathname=filename
      const resolved=new URL(original.source,base)
      return {file:resolved.protocol==='file:'?decodeURIComponent(resolved.pathname):resolved.href,line:original.line,column:original.column+1}
    })
    return `${lowered.code}\n//# sourceURL=${url}\n`
  }
  return `${String(code)}\n//# sourceURL=${filename}\n`
}

export class Script extends browserVm.Script{
  #source:string
  #classic:ReturnType<typeof createClassicVmScript>|undefined
  constructor(code:unknown,options?:ScriptOptions|string){
    validateScriptOptions(options)
    const classic=(globalThis as any).process?.env?.NATIVE_CLASSIC_VM==='1'
    const source=classic?String(code):scriptSource(code,options)
    super(source)
    this.#source=source
    if(classic){
      const filename=(typeof options==='string'?options:options?.filename)??'evalmachine.<anonymous>'
      if(/[\r\n\u2028\u2029]/.test(filename))throw new TypeError('Script filename cannot contain a line break')
      this.#classic=createClassicVmScript(source,filename,
        typeof options==='object'?options.lineOffset??0:0,
        typeof options==='object'?options.columnOffset??0:0)
    }
  }
  runInThisContext(options?:unknown){
    validateExecutionOptions(options)
    if(this.#classic)return this.#classic.evaluate()
    return (0,eval)(this.#source)
  }
  runInContext(context:unknown,options?:unknown){
    validateExecutionOptions(options)
    return super.runInContext(context)
  }
  runInNewContext(context?:unknown,options?:unknown){
    validateExecutionOptions(options)
    return super.runInNewContext(context)
  }
}
export function runInThisContext(code:unknown,options?:ScriptOptions|string){
  return new Script(code,options).runInThisContext(typeof options==='string'?undefined:options)
}
export function runInContext(code:unknown,context:unknown,options?:ScriptOptions|string){
  return new Script(code,options).runInContext(context,typeof options==='string'?undefined:options)
}
export function runInNewContext(code:unknown,context?:unknown,options?:ScriptOptions|string){
  return new Script(code,options).runInNewContext(context,typeof options==='string'?undefined:options)
}
export const createScript=(code:unknown,options?:ScriptOptions|string)=>new Script(code,options)
export const createContext=browserVm.createContext
export const isContext=browserVm.isContext
export default {...browserVm,Script,createScript,runInThisContext,runInContext,runInNewContext}
