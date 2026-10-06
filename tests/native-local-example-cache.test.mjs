import assert from 'node:assert/strict'
import test from 'node:test'
import {resolve} from 'node:path'
import {localNativeExamples} from '../integrations/tanstack-site/local-native-examples.mjs'

test('the native fixture plugin leaves non-native hosts untouched',()=>{
  const previous=process.env.VITE_LOCAL_NATIVE_SANDBOX
  try{
    delete process.env.VITE_LOCAL_NATIVE_SANDBOX
    assert.equal(localNativeExamples(),false)
    process.env.VITE_LOCAL_NATIVE_SANDBOX='0'
    assert.equal(localNativeExamples(),false)
  }finally{
    if(previous===undefined)delete process.env.VITE_LOCAL_NATIVE_SANDBOX
    else process.env.VITE_LOCAL_NATIVE_SANDBOX=previous
  }
})

test('native fixture caches belong to their roots, not shared node_modules',()=>{
  const previous=process.env.VITE_LOCAL_NATIVE_SANDBOX
  process.env.VITE_LOCAL_NATIVE_SANDBOX='1'
  try{
    const plugin=localNativeExamples()
    assert.equal(plugin.apply,'serve')
    const first=plugin.config({root:'/private/tmp/site-first'})
    const second=plugin.config({root:'/private/tmp/site-second'})
    assert.deepEqual(first,{cacheDir:'/private/tmp/site-first/.native-local/vite-cache'})
    assert.deepEqual(second,{cacheDir:'/private/tmp/site-second/.native-local/vite-cache'})
    assert.notEqual(first.cacheDir,second.cacheDir)
    assert.equal(plugin.config({}).cacheDir,resolve('.native-local/vite-cache'))
  }finally{
    if(previous===undefined)delete process.env.VITE_LOCAL_NATIVE_SANDBOX
    else process.env.VITE_LOCAL_NATIVE_SANDBOX=previous
  }
})

test('the fixture-owned cache replaces a caller cache shared across diagnostic hosts',()=>{
  const previous=process.env.VITE_LOCAL_NATIVE_SANDBOX
  process.env.VITE_LOCAL_NATIVE_SANDBOX='1'
  try{
    assert.deepEqual(localNativeExamples().config({root:'/private/tmp/site-first',cacheDir:'/private/tmp/shared-node_modules/.vite'}),
      {cacheDir:'/private/tmp/site-first/.native-local/vite-cache'})
  }finally{
    if(previous===undefined)delete process.env.VITE_LOCAL_NATIVE_SANDBOX
    else process.env.VITE_LOCAL_NATIVE_SANDBOX=previous
  }
})
