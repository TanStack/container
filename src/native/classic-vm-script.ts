import {compileClassicScriptCompletion,createClassicScriptCompletionChannel} from './classic-script-completion'
import {transformNodeReturns} from './node-return-transform'
import {workerSourceLocations} from './browser-source-locations'
import {browserInlineSourceMap} from './browser-inline-source-map'
import {TraceMap,originalPositionFor} from '@jridgewell/trace-mapping'

let identity=0
export function createClassicVmScript(source:string,filename:string,lineOffset=0,columnOffset=0){
  const key=`__tanstack_container_vm_completion_${++identity}`
  const lowered=transformNodeReturns(source,filename)
  const compiled=compileClassicScriptCompletion(lowered.code!,filename,key)
  const completionMap=new TraceMap(compiled.map as any)
  const returnMap=new TraceMap(lowered.map as any)
  const originalMap=browserInlineSourceMap(source)
  const originalTrace=originalMap?new TraceMap(originalMap as any):undefined
  const trace=(globalThis as any).process?.env?.NATIVE_VM_SOURCE_TRACE===filename
  if(trace)console.error('CLASSIC_VM_SOURCE',JSON.stringify({filename,lineOffset,columnOffset,source,map:originalMap}))
  return {evaluate(){
    const channel=createClassicScriptCompletionChannel()
    const previous=Object.getOwnPropertyDescriptor(globalThis,key)
    const url=URL.createObjectURL(new Blob([compiled.code!],{type:'text/javascript'}))
    workerSourceLocations.register(url,(line,column)=>{
      const completion=originalPositionFor(completionMap,{line,column:column-1})
      if(completion.line===null||completion.column===null)return null
      const input=originalPositionFor(returnMap,{line:completion.line,column:completion.column})
      if(input.line===null||input.column===null)return null
      const adjustedLine=input.line+lineOffset,adjustedColumn=input.column+(input.line===1?columnOffset:0)
      if(trace)console.error('CLASSIC_VM_POSITION',JSON.stringify({line,column,completion,input,adjustedLine,adjustedColumn,original:originalTrace&&adjustedLine>0&&adjustedColumn>=0?originalPositionFor(originalTrace,{line:adjustedLine,column:adjustedColumn}):null}))
      if(adjustedLine<1||adjustedColumn<0)return null
      if(!originalTrace)return {file:filename,line:adjustedLine,column:adjustedColumn+1}
      const original=originalPositionFor(originalTrace,{line:adjustedLine,column:adjustedColumn})
      if(original.source===null||original.line===null||original.column===null)return null
      const base=new URL('file:///');base.pathname=filename
      const resolved=new URL(original.source,base)
      return {file:resolved.protocol==='file:'?decodeURIComponent(resolved.pathname):resolved.href,line:original.line,column:original.column+1}
    })
    try{
      Object.defineProperty(globalThis,key,{value:channel,configurable:true})
      globalThis.importScripts(url)
      return channel.value
    }finally{
      URL.revokeObjectURL(url)
      if(previous)Object.defineProperty(globalThis,key,previous)
      else Reflect.deleteProperty(globalThis,key)
    }
  }}
}
