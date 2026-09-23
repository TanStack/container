import {describe,it,expect} from 'vitest'
import {builtinModules} from '../src/compiler/builtins'
import nodeCoreSource from '../src/compiler/generated/node-core.js?raw'
import zlibSource from '../src/compiler/generated/zlib.js?raw'
import nativeTypes from 'node:util/types'

describe('shared Node core source',()=>{
  it('loads the compression engine only in the zlib builtin',()=>{
    const owners=Object.entries(builtinModules).filter(([,source])=>source.includes(zlibSource)).map(([name])=>name)
    expect(owners).toEqual(['node:zlib'])
    expect(builtinModules['node:zlib']).toContain("import process from 'node:process'")
  })
  it('embeds the implementation only in the process initializer',()=>{
    const owners=Object.entries(builtinModules).filter(([,source])=>source.includes(nodeCoreSource)).map(([name])=>name)
    expect(owners).toEqual(['node:process'])
  })

  it('orders core facades after process initialization without copying its source',()=>{
    for(const name of ['node:util','node:assert','node:querystring','node:crypto','node:buffer','node:path','node:stream','node:stream/promises']){
      const source=builtinModules[name]!
      expect(source,name).toContain("import process from 'node:process'")
      expect(source,name).toContain('const core=globalThis.__webContainerHost.nodeCore;')
      expect(source.length,name).toBeLessThan(nodeCoreSource.length)
    }
  })

  it('exposes the native Node 22 util types predicate surface as a pure facade',()=>{
    const source=builtinModules['node:util/types']!
    const names=['isAnyArrayBuffer','isArgumentsObject','isArrayBuffer','isArrayBufferView','isAsyncFunction','isBigInt64Array','isBigIntObject','isBigUint64Array','isBooleanObject','isBoxedPrimitive','isDataView','isDate','isFloat32Array','isFloat64Array','isGeneratorFunction','isGeneratorObject','isInt16Array','isInt32Array','isInt8Array','isMap','isMapIterator','isNativeError','isNumberObject','isPromise','isRegExp','isSet','isSetIterator','isSharedArrayBuffer','isStringObject','isSymbolObject','isTypedArray','isUint16Array','isUint32Array','isUint8Array','isUint8ClampedArray','isWeakMap','isWeakSet']
    expect(source).toContain("import {types} from 'node:util'")
    for(const name of names){expect(typeof nativeTypes[name as keyof typeof nativeTypes],name).toBe('function');expect(source,name).toContain(name)}
    const values=[new Map(),new Set(),new Uint8Array(),new DataView(new ArrayBuffer(1)),Promise.resolve(),new Number(1),/x/,new Error('x')]
    expect(values.map(value=>[nativeTypes.isMap(value),nativeTypes.isSet(value),nativeTypes.isTypedArray(value),nativeTypes.isDataView(value),nativeTypes.isPromise(value),nativeTypes.isBoxedPrimitive(value),nativeTypes.isRegExp(value),nativeTypes.isNativeError(value)])).toEqual([
      [true,false,false,false,false,false,false,false],
      [false,true,false,false,false,false,false,false],
      [false,false,true,false,false,false,false,false],
      [false,false,false,true,false,false,false,false],
      [false,false,false,false,true,false,false,false],
      [false,false,false,false,false,true,false,false],
      [false,false,false,false,false,false,true,false],
      [false,false,false,false,false,false,false,true],
    ])
  })
})
