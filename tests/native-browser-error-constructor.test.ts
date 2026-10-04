import {expect,test} from 'vitest'
import {createBrowserErrorConstructor,installBrowserErrorConstructor} from '../src/native/browser-error-constructor'
import {createContext,runInContext} from 'node:vm'

test('preserves native errors, calls, causes and writable stacks',()=>{
  const GuestError=createBrowserErrorConstructor(Error,stack=>stack+'\nverified mapping')
  const cause={owned:true}
  for(const error of [new GuestError('owned',{cause}),GuestError('owned',{cause})]){
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(GuestError)
    expect(error.message).toBe('owned')
    expect(error.cause).toBe(cause)
    expect(error.stack).toContain('verified mapping')
    expect(Object.getOwnPropertyDescriptor(error,'stack')?.enumerable).toBe(false)
    error.stack='guest replacement'
    expect(error.stack).toBe('guest replacement')
  }
})
test('owned realm installation preserves constructor identity without changing the host realm',()=>{
  const context=createContext({})
  const scope=runInContext('globalThis',context)
  const HostError=Error,hostConstructor=Error.prototype.constructor
  const Guest=installBrowserErrorConstructor(scope,stack=>stack+'\nmapped')
  expect(scope.Error).toBe(Guest)
  expect(Guest.prototype.constructor).toBe(Guest)
  for(const error of [Guest('called'),new Guest('constructed')]){
    expect(error.constructor).toBe(Guest)
    expect(error).toBeInstanceOf(Guest)
    expect(error.stack).toContain('mapped')
  }
  const implicit=runInContext('try{null.missing}catch(error){error}',context)
  expect(implicit).toBeInstanceOf(Guest)
  expect(Error).toBe(HostError)
  expect(Error.prototype.constructor).toBe(hostConstructor)
})
test('preserves subclass prototypes and native static properties',()=>{
  const GuestError=createBrowserErrorConstructor(Error,stack=>stack)
  class OwnedError extends GuestError {owned=true}
  const error=new OwnedError('subclass')
  expect(error).toBeInstanceOf(OwnedError)
  expect(error).toBeInstanceOf(Error)
  expect(error.owned).toBe(true)
  expect(error.constructor).toBe(OwnedError)
  expect(typeof GuestError.captureStackTrace).toBe(typeof Error.captureStackTrace)
  const captured={} as Error
  GuestError.captureStackTrace(captured)
  expect(captured.stack).toBeTypeOf('string')
})
test('captureStackTrace maps stacks replaced after construction and preserves user replacements',()=>{
  const nativeCapture=Error.captureStackTrace
  const Guest=createBrowserErrorConstructor(Error,stack=>stack+'\nmapped capture')
  const error=new Guest('owned')
  error.stack='old replacement'
  Guest.captureStackTrace(error)
  expect(error.stack).toContain('mapped capture')
  error.stack='new replacement'
  expect(error.stack).toBe('new replacement')
  const original=Guest.captureStackTrace
  Guest.captureStackTrace=()=>{}
  expect(Guest.captureStackTrace).not.toBe(original)
  Guest.captureStackTrace=nativeCapture
})
test('preserves built-in error kinds and subclass-owned stack descriptors',()=>{
  for(const Native of [TypeError,RangeError,SyntaxError,ReferenceError,URIError,EvalError]){
    const Guest=createBrowserErrorConstructor(Native,stack=>stack)
    const error=new Guest('owned',{cause:42})
    expect(error).toBeInstanceOf(Native)
    expect(error.name).toBe(Native.name)
    expect(error.cause).toBe(42)
  }
  class LockedError extends Error {
    constructor(){super('locked');Object.defineProperty(this,'stack',{value:'owned stack',configurable:false,writable:false})}
  }
  const Guest=createBrowserErrorConstructor(LockedError as ErrorConstructor,()=>{throw Error('must not map locked property')})
  expect(new Guest().stack).toBe('owned stack')
})
test('retains lazy stack getters and does not remap guest replacements',()=>{
  let reads=0
  class LazyError extends Error {
    constructor(){
      super('lazy')
      let stack='captured'
      Object.defineProperty(this,'stack',{configurable:true,enumerable:false,get(){reads++;return stack},set(value){stack=value}})
    }
  }
  const Guest=createBrowserErrorConstructor(LazyError as ErrorConstructor,stack=>'mapped '+stack)
  const error=new Guest()
  expect(reads).toBe(0)
  expect(error.stack).toBe('mapped captured')
  expect(reads).toBe(1)
  error.stack='guest replacement'
  expect(error.stack).toBe('guest replacement')
  expect(reads).toBe(2)
})
test('preserves setter conversion and leaves mapping enabled after rejected assignment',()=>{
  class ConvertedError extends Error {
    constructor(){
      super('converted')
      let stack='captured'
      Object.defineProperty(this,'stack',{configurable:true,get(){return stack},set(value){
        if(value==='reject')throw new TypeError('rejected')
        stack=String(value).toUpperCase()
      }})
    }
  }
  const Guest=createBrowserErrorConstructor(ConvertedError as ErrorConstructor,stack=>'mapped '+stack)
  const error=new Guest()
  expect(()=>{error.stack='reject'}).toThrow('rejected')
  expect(error.stack).toBe('mapped captured')
  error.stack='owned'
  expect(error.stack).toBe('OWNED')
})
