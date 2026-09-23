import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRolldownGuestBinding} from '../src/compiler/rolldown-guest-binding.js'

const callableNames=['builtin:vite-resolve','builtin:oxc-runtime','builtin:vite-json','builtin:vite-react-refresh-wrapper']

test('synthetic binding exposes import-safe enums and MagicString shape',()=>{
  const binding=createRolldownGuestBinding()
  assert.equal(binding.BindingLogLevel.Silent,0)
  assert.equal(binding.BindingBuiltinPluginName.ViteResolve,'builtin:vite-resolve')
  assert.equal(binding.ModuleType.CommonJs,'commonjs')
  assert.equal(binding.__napiBindingTarget,'wasm32-wasi')
  for(const name of ['append','overwrite','replaceRegex','generateMap','toString'])assert.equal(typeof binding.BindingMagicString.prototype[name],'function')
  assert.throws(()=>new binding.BindingMagicString('source'),error=>error.code==='ERR_UNSUPPORTED_OPERATION')
  assert.equal(typeof binding.parseSync,'function')
})

test('synthetic callable metadata matches the pinned supported descriptors',()=>{
  const {BindingCallableBuiltinPlugin}=createRolldownGuestBinding()
  for(const descriptor of callableNames){
    const plugin=new BindingCallableBuiltinPlugin({__name:descriptor})
    assert.deepEqual([...function*(){for(const name in plugin)yield name}()],['getOrder','load','resolveId','transform','watchChange'])
    assert.equal(plugin.getOrder('load'),descriptor==='builtin:oxc-runtime'?'pre':null)
    assert.equal(plugin.getOrder('resolveId'),['builtin:oxc-runtime','builtin:vite-react-refresh-wrapper'].includes(descriptor)?'pre':null)
    assert.equal(plugin.getOrder('transform'),null)
  }
  assert.throws(()=>new BindingCallableBuiltinPlugin({__name:'builtin:other'}),error=>error.code==='ERR_UNSUPPORTED_OPERATION')
})
