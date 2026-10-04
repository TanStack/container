import {transformAsync} from '@babel/core'
import importedAsyncToGenerator from '@babel/plugin-transform-async-to-generator'
import type {Plugin} from 'vite'
import {dataModuleURL} from './data-module'

// Native async iterators must retain their language-level shape. In particular,
// lowering an async generator makes its next/throw/return methods enumerable,
// which a server-function serializer can mistake for payload data. Babel's
// ordinary async transform does not rewrite `for await`, so functions that use
// it also need to remain native until the context adapter supports them.
function asyncContextBabelPlugin(api:unknown){
  let factory:unknown=importedAsyncToGenerator
  while(factory&&typeof factory!=='function')factory=(factory as {default?:unknown}).default
  if(typeof factory!=='function')throw Error('Async transform plugin is not callable')
  const base=factory(api,{})
  const transformFunction=base.visitor?.Function
  if(typeof transformFunction!=='function')throw Error('Async transform has no Function visitor')
  return {
    ...base,
    visitor:{...base.visitor,Function(path:any,state:any){
      const parent=path.parentPath
      if(parent?.isCallExpression()&&parent.node.callee?.object?.name==='Object'&&parent.node.callee?.property?.name==='getPrototypeOf')return
      if(parent?.isMemberExpression()&&parent.node.property?.name==='constructor')return
      let hasForAwait=false
      let constructsAsyncFunction=false
      path.traverse({
        Function(inner:any){inner.skip()},
        ForOfStatement(inner:any){if(inner.node.await)hasForAwait=true},
        NewExpression(inner:any){if(inner.node.callee?.name==='AsyncFunction')constructsAsyncFunction=true},
      })
      if(!hasForAwait&&!constructsAsyncFunction)transformFunction.call(state,path,state)
    }},
  }
}

/** Lower safe ordinary async functions so promise continuations preserve worker ALS. */
export async function transformNativeAsyncContext(source:string,id:string){
  if(!source.includes('async')&&!source.includes('await'))return null
  const result=await transformAsync(source,{
    babelrc:false,
    configFile:false,
    plugins:[asyncContextBabelPlugin],
    sourceType:'module',
    filename:id,
    compact:true,
    sourceMaps:true,
  })
  return result?.code?{code:result.code,map:result.map||null}:null
}

export function asyncContextTransform(onActivity?:(phase:'start'|'end',id:string,bytes:number)=>void):Plugin{
  return {
    name:'browser-native-async-context',
    apply:'serve',
    enforce:'post',
    async transform(source,id){
      if(this.environment.name==='client'||!id.startsWith('/app/')&&!dataModuleURL(id))return
      if(source.length<100_000)return transformNativeAsyncContext(source,id)
      onActivity?.('start',id,source.length)
      try{return await transformNativeAsyncContext(source,id)}
      finally{onActivity?.('end',id,source.length)}
    },
  }
}
