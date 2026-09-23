import vm from 'node:vm'
import {contextGlobalCases} from '../fixtures/context-global-cases.mjs'

export function contextGlobalsReference(){
  return Object.fromEntries(contextGlobalCases.map(fixture=>{
    const parent=vm.createContext({})
    const sandbox=vm.runInContext(`globalThis.sandbox=${fixture.setup};sandbox`,parent)
    const child=vm.createContext(sandbox,{codeGeneration:{strings:fixture.strings!==false,wasm:false}})
    parent.runInChild=(source,timeout)=>vm.runInContext(source,child,{timeout})
    const values=fixture.steps.map(([realm,source])=>{
      try{
        const value=vm.runInContext(source,realm==='parent'?parent:child,{timeout:3000})
        return value===undefined?{undefined:true}:JSON.parse(JSON.stringify({value}))
      }catch(error){return {error:error.name}}
    })
    return [fixture.name,values]
  }))
}
