import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createGuestCallableAdapter} from '../src/compiler/guest-callable-adapter.js'
function fixture(){
  function Original(descriptor){this.descriptor=descriptor}
  Original.marker=42
  Original.prototype.getOrder=function(name){return name==='resolveId'?'pre':null}
  for(const name of ['resolveId','load','transform','watchChange'])Original.prototype[name]=function(){throw Error('Guest native async hook must not run')}
  const registered=[],invocations=[],released=[]
  const dispatch={register(callbacks){registered.push(callbacks);return registered.length},release(id){released.push(id)},invoke(...args){invocations.push(args);return Promise.resolve('native result')}}
  const host={register(){},release(){}}
  return {Original,registered,invocations,released,dispatch,host}
}
test('preserves original constructor identity/order and routes async hooks',async()=>{
  const f=fixture(),callback=()=>'/resolved',Adapted=createGuestCallableAdapter(f.Original,f.dispatch,f.host)
  const descriptor={__name:'builtin:vite-resolve',options:{resolveSubpathImports:callback,builtins:[/^node:/]}}
  let encoded,hooks
  f.host.register=(_id,value,metadata)=>{encoded=value;hooks=metadata}
  const plugin=new Adapted(descriptor)
  assert.ok(plugin instanceof Adapted);assert.ok(plugin instanceof f.Original);assert.equal(Adapted.marker,42)
  assert.equal(plugin.getOrder('resolveId'),'pre');assert.equal(f.registered[0].resolveSubpathImports,callback)
  assert.deepEqual(encoded.options.builtins,[{type:'RegExp',source:'^node:',flags:''}])
  assert.ok(hooks.some(item=>item.name==='resolveId'&&item.order==='pre'))
  for(const name of ['resolveId','load','transform','watchChange'])assert.equal(await plugin[name]('argument'),'native result')
  assert.deepEqual(f.invocations.map(row=>row[1]),['resolveId','load','transform','watchChange'])
})
test('non-target builtins fail clearly and failed registration releases callback handles',()=>{
  const f=fixture(),Adapted=createGuestCallableAdapter(f.Original,f.dispatch,f.host)
  assert.throws(()=>new Adapted({__name:'builtin:unhandled'}),error=>error.code==='ERR_UNSUPPORTED_OPERATION')
  assert.equal(f.registered.length,0)
  f.host.register=()=>{throw Error('Registration refused')}
  assert.throws(()=>new Adapted({__name:'builtin:vite-resolve',options:{}}),/Registration refused/)
  assert.deepEqual(f.released,[1])
})
test('client runtime and JSON plugins never invoke guest native hooks',async()=>{
  for(const descriptor of [{__name:'builtin:oxc-runtime'},{__name:'builtin:vite-json',options:{stringify:'auto',namedExports:true,minify:false}}]){
    const f=fixture(),Adapted=createGuestCallableAdapter(f.Original,f.dispatch,f.host),plugin=new Adapted(descriptor)
    for(const name of ['resolveId','load','transform','watchChange'])assert.equal(await plugin[name]('argument'),'native result')
    assert.equal(f.registered.length,1)
  }
})
