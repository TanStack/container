import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createGuestCallableAdapter} from '../src/compiler/guest-callable-adapter.js'
import {descriptor as resolverDescriptor} from './fixtures/rolldown-native-probe/resolve-cases.mjs'
import {t as requireBinding} from './fixtures/rolldown-native-probe/node_modules/rolldown/dist/shared/binding-BbrDfv1x.mjs'
const built=await build({entryPoints:['src/compiler/rolldown-callable-protocol.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const {restoreCallableDescriptor}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'))
test('adapted runtime and JSON callable results match installed native binding',async()=>{
  const binding=requireBinding()
  try{
    for(const descriptor of [{__name:'builtin:oxc-runtime'},{__name:'builtin:vite-json',options:{namedExports:true,stringify:'auto',minify:false}}]){
      let remote,calls=0
      const Adapted=createGuestCallableAdapter(binding.BindingCallableBuiltinPlugin,{register(){return 1},release(){},invoke(_handle,method,args){calls++;return remote[method](...args)}},{register(_handle,value,hooks){remote=new binding.BindingCallableBuiltinPlugin(restoreCallableDescriptor(value,()=>{throw Error('Unexpected callback')}));for(const {name,order} of hooks)assert.equal(remote.getOrder(name),order)}})
      const adapted=new Adapted(descriptor),baseline=new binding.BindingCallableBuiltinPlugin(descriptor)
      for(const [method,args] of [['resolveId',['/src/example.json',undefined,{isEntry:false,ssr:false}]],['load',['/src/example.json',{ssr:false}]],['transform',['{"answer":42}','/src/example.json',{ssr:false,moduleType:'json'}]]])assert.deepEqual(await adapted[method](...args),await baseline[method](...args))
      assert.equal(calls,3)
      for(const event of ['create','update','delete'])assert.deepEqual(await adapted.watchChange('/src/example.json',{event}),await baseline.watchChange('/src/example.json',{event}))
    }
    const resolver=new binding.BindingCallableBuiltinPlugin(resolverDescriptor('/project',()=>undefined,()=>{}))
    const resolverBaseline=new binding.BindingCallableBuiltinPlugin(resolverDescriptor('/project',()=>undefined,()=>{}))
    for(const event of ['create','update','delete'])assert.deepEqual(await resolver.watchChange('/project/src/example.js',{event}),await resolverBaseline.watchChange('/project/src/example.js',{event}))
  }finally{await binding.shutdownAsyncRuntime()}
})
