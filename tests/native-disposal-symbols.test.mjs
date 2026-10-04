import test from 'node:test'
import assert from 'node:assert/strict'
import {installNodeDisposalSymbols} from '../src/native/disposal-symbols.mjs'

function olderSymbol(existing={}){
  const constructor=description=>Symbol(description)
  Object.assign(constructor,existing)
  return constructor
}

test('missing disposal symbols have distinct identities and Node property descriptors',()=>{
  const constructor=olderSymbol()
  installNodeDisposalSymbols(constructor)
  assert.notEqual(constructor.dispose,constructor.asyncDispose)
  for(const name of ['dispose','asyncDispose']){
    const symbol=constructor[name]
    assert.equal(typeof symbol,'symbol')
    assert.equal(symbol.description,Symbol[name].description)
    assert.equal(Symbol.keyFor(symbol),undefined)
    assert.deepEqual(Object.getOwnPropertyDescriptor(constructor,name),{
      ...Object.getOwnPropertyDescriptor(Symbol,name),value:symbol,
    })
  }
})

test('repeated installation retains symbol identities and native symbols',()=>{
  const dispose=Symbol('existing native dispose'),constructor=olderSymbol({dispose})
  const descriptor=Object.getOwnPropertyDescriptor(constructor,'dispose')
  installNodeDisposalSymbols(constructor)
  const asyncDispose=constructor.asyncDispose
  installNodeDisposalSymbols(constructor)
  assert.equal(constructor.dispose,dispose)
  assert.equal(constructor.asyncDispose,asyncDispose)
  assert.deepEqual(Object.getOwnPropertyDescriptor(constructor,'dispose'),descriptor)
  const before=['dispose','asyncDispose'].map(name=>Object.getOwnPropertyDescriptor(Symbol,name))
  installNodeDisposalSymbols()
  assert.deepEqual(['dispose','asyncDispose'].map(name=>Object.getOwnPropertyDescriptor(Symbol,name)),before)
})

test('handle classes expose separate sync and async cleanup methods after installation',async()=>{
  const constructor=olderSymbol(),calls=[]
  installNodeDisposalSymbols(constructor)
  class Handle{
    [constructor.dispose](){calls.push('sync')}
    async [constructor.asyncDispose](){await Promise.resolve();calls.push('async')}
  }
  const handle=new Handle()
  handle[constructor.dispose]()
  await handle[constructor.asyncDispose]()
  assert.deepEqual(calls,['sync','async'])
  assert.equal(Object.hasOwn(Handle.prototype,'undefined'),false)
})
