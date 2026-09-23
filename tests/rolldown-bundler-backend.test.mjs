import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {snapshotBindingResult,encodeBindingSnapshot,restoreGuestBindingResult} from '../src/compiler/rolldown-binding-output.js'
import {t as requireBinding} from './fixtures/rolldown-native-probe/node_modules/rolldown/dist/shared/binding-BbrDfv1x.mjs'
import {t as createBundlerOptions} from './fixtures/rolldown-native-probe/node_modules/rolldown/dist/shared/create-bundler-option-DJpvtSqr.mjs'
import {u as transformToRollupOutput} from './fixtures/rolldown-native-probe/node_modules/rolldown/dist/shared/bindingify-input-options-D4l624og.mjs'
const built=await build({entryPoints:['src/compiler/rolldown-bundler-backend.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const {NativeBundlerBackend}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'))

test('real native bundler retains bindingified plugin callbacks and output wrapper parity',async()=>{
  const callbacks=new Map(),scopes=[],binding=requireBinding(),outputCalls=[]
  let contextResolves=0
  let backend
  const revive=(value,scope)=>{
    if(!value||typeof value!=='object')return value
    if(Array.isArray(value))return value.map(item=>revive(item,scope))
    if(value.type==='native-context')return Object.fromEntries(value.methods.map(method=>[method,method==='inner'?()=>revive(value.inner,scope):(...args)=>revive(backend.invokeContext(scope,value.handle,method,args),scope)]))
    return value
  }
  backend=new NativeBundlerBackend(binding,{
    async asyncCallback(id,args,scope){scopes.push(scope);return await callbacks.get(id)(...args.map(value=>revive(value,scope)))},
    syncCallback(id,args,scope){return callbacks.get(id)(...args.map(value=>revive(value,scope)))},
  },16*1024*1024,value=>encodeBindingSnapshot(snapshotBindingResult(value)))
  const encode=value=>{
    if(typeof value==='function'){const id=callbacks.size+1;callbacks.set(id,value);return {type:'guest-callback',id}}
    if(value instanceof RegExp)return {type:'RegExp',source:value.source,flags:value.flags}
    if(Array.isArray(value))return value.map(encode)
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item)]))
    return value
  }
  const options=await createBundlerOptions({input:'owned-entry',plugins:[{
    name:'owned-bundler',
    async resolveId(id){
      if(id==='owned-entry')return '/owned-entry.js'
      if(id==='alias'){contextResolves++;return await this.resolve('target',undefined,{skipSelf:true})}
    },
    load(id){if(id==='/owned-entry.js')return 'export {answer} from "alias"'},
  },{
    name:'owned-nested-resolver',resolveId(id){if(id==='target')return '/target.js'},load(id){if(id==='/target.js')return 'export const answer=42'},
  }]},{format:'esm',sourcemap:'hidden',
    entryFileNames(chunk){outputCalls.push('entryFileNames');return chunk.name+'-owned.js'},
    sourcemapFileNames(chunk){outputCalls.push('sourcemapFileNames');return chunk.name+'-owned.map'},
    sourcemapPathTransform(source){outputCalls.push('sourcemapPathTransform');return 'owned://'+source},
    sourcemapIgnoreList(){outputCalls.push('sourcemapIgnoreList');return true},
    async banner(chunk){outputCalls.push('banner');return '// owned banner '+chunk.name},
    async footer(){outputCalls.push('footer');return '// owned footer'},
  },false)
  const reference=new binding.BindingBundler();binding.startAsyncRuntime()
  let expected
  try{expected=transformToRollupOutput(await reference.generate(options.bundlerOptions)).output.map(item=>JSON.parse(JSON.stringify(item)))}finally{await reference.close();binding.shutdownAsyncRuntime()}
  const handle=backend.create()
  try{
    const result=await backend.run(handle,'generate',encode(options.bundlerOptions))
    const output=transformToRollupOutput(restoreGuestBindingResult(structuredClone(result.result))).output
    assert.deepEqual(output.map(item=>JSON.parse(JSON.stringify(item))),expected)
    assert.ok(output[0].code.includes('42'))
    assert.ok(output[0].code.includes('// owned banner'))
    assert.ok(output[0].code.includes('// owned footer'))
    assert.ok(output[0].fileName.endsWith('-owned.js'))
    assert.ok(output[0].map.sources.every(source=>source.startsWith('owned://')))
    for(const name of ['entryFileNames','sourcemapFileNames','sourcemapPathTransform','sourcemapIgnoreList','banner','footer'])assert.ok(outputCalls.includes(name),name)
    assert.ok(scopes.length>0)
    assert.ok(contextResolves>0)
    assert.ok(scopes.every(scope=>!backend.hasScope(scope)))
    assert.equal(result.closed,false)
    const scanned=await backend.run(handle,'scan',encode(options.bundlerOptions))
    assert.equal(scanned.result,undefined)
  }finally{await backend.close(handle)}
  assert.equal(backend.active,0)
  assert.throws(()=>backend.invokeContext(scopes[0],1,'inner',[]),/Expired/)
})

test('a bundler operation can run more than 64 plugin callbacks concurrently',async()=>{
  const callbackCount=128,pending=[]
  class BindingBundler{
    closed=false
    async generate(options){
      await Promise.all(Array.from({length:callbackCount},(_,index)=>options.plugins[0].resolveId(String(index))))
      return {output:[]}
    }
    getWatchFiles(){return []}
    async close(){this.closed=true}
  }
  const binding={BindingBundler,startAsyncRuntime(){},shutdownAsyncRuntime(){}}
  const backend=new NativeBundlerBackend(binding,{
    async asyncCallback(_id,args){return await new Promise(resolve=>pending.push(()=>resolve(args[0])))},
    syncCallback(){throw Error('Unexpected sync callback')},
  },1024*1024,value=>value)
  const handle=backend.create()
  const result=backend.run(handle,'generate',{plugins:[{resolveId:{type:'guest-callback',id:1}}]})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(pending.length,callbackCount)
  for(const release of pending)release()
  await result
  await backend.close(handle)
})
