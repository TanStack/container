import {afterEach,describe,expect,it} from 'vitest'
import {vol} from '../src/vite-browser/node-fs'
import * as liveFs from '../src/vite-browser/node-fs'
import {BrowserCommonJS} from '../src/native/commonjs'
import {createRequire} from '../src/vite-browser/node-module'

afterEach(()=>vol.reset())

describe('browser CommonJS loader',()=>{
  it('refreshes transitive cached exports and restores their identity on failure',async()=>{
    vol.fromJSON({'/app/main.cjs':'module.exports={value:require("./value.cjs")}',
      '/app/value.cjs':'module.exports=1'})
    const loader=new BrowserCommonJS()
    const old=loader.load('/app/main.cjs')
    vol.writeFileSync('/app/value.cjs','module.exports=2')
    expect(loader.load('/app/main.cjs')).toBe(old)
    await expect(loader.refresh(async()=>{
      expect(loader.load('/app/main.cjs')).toEqual({value:2})
      throw Error('publication failed')
    })).rejects.toThrow('publication failed')
    expect(loader.load('/app/main.cjs')).toBe(old)
    const current=await loader.refresh(async()=>loader.load('/app/main.cjs'))
    expect(current).toEqual({value:2})
    expect(current).not.toBe(old)
    expect(loader.load('/app/main.cjs')).toBe(current)
  })
  it('rejects overlapping refreshes without replacing the active graph',async()=>{
    const loader=new BrowserCommonJS()
    await loader.refresh(async()=>{
      await expect(loader.refresh(async()=>undefined)).rejects.toThrow('already running')
    })
    await expect(loader.refresh(async()=>42)).resolves.toBe(42)
  })
  it('keeps eval identity separate from its workspace resolution path',()=>{
    vol.fromJSON({'/app/value.cjs':'module.exports=42'})
    const loader=new BrowserCommonJS()
    expect(loader.evaluate('module.exports={filename:__filename,dirname:__dirname,id:module.id,path:module.filename,value:require("./value.cjs")}', '/app/[eval]')).toEqual({
      filename:'[eval]',dirname:'.',id:'[eval]',path:'/app/[eval]',value:42,
    })
    expect(()=>loader.evaluate('', '/outside/[eval]')).toThrow('outside the container filesystem')
  })
  it('uses require conditions for private imports and respects the nearest package scope',()=>{
    vol.fromJSON({
      '/tmp/private/package.json':JSON.stringify({imports:{
        '#value':{import:'./import.cjs',require:'./require.cjs'},
        '#parts/*':'./parts/*.cjs',
        '#blocked':null,
        '#blocked-condition':{require:null,default:'./require.cjs'},
        '#path':'path',
      }}),
      '/tmp/private/main.cjs':'module.exports=[require("#value"),require("#parts/value")]',
      '/tmp/private/import.cjs':'module.exports="wrong import branch"',
      '/tmp/private/require.cjs':'module.exports=42',
      '/tmp/private/parts/value.cjs':'module.exports=43',
      '/tmp/private/nested/package.json':'{}',
      '/tmp/private/nested/main.cjs':'module.exports=require("#value")',
    })
    const loader=new BrowserCommonJS()
    expect(loader.load('/tmp/private/main.cjs')).toEqual([42,43])
    expect(loader.resolve('#value','/tmp/private/main.cjs')).toBe('/tmp/private/require.cjs')
    expect(()=>loader.resolve('#path','/tmp/private/main.cjs')).toThrow()
    expect(()=>loader.resolve('#blocked','/tmp/private/main.cjs')).toThrow('unavailable to require')
    expect(()=>loader.resolve('#blocked-condition','/tmp/private/main.cjs')).toThrow('unavailable to require')
    expect(()=>loader.load('/tmp/private/nested/main.cjs')).toThrow('unavailable to require')
  })
  it('loads scratch CommonJS relatives and honors scratch package type',()=>{
    vol.fromJSON({'/tmp/modules/main.cjs':'module.exports=require("./value.cjs")',
      '/tmp/modules/value.cjs':'module.exports=42',
      '/tmp/modules/package.json':'{"type":"module"}',
      '/tmp/modules/esm.js':'export default 43'})
    const loader=new BrowserCommonJS()
    expect(loader.load('/tmp/modules/main.cjs')).toBe(42)
    expect(createRequire('file:///tmp/modules/entry.mjs')('./value.cjs')).toBe(42)
    expect(loader.isCommonJS('/tmp/modules/esm.js')).toBe(false)
    expect(()=>loader.load('/tmp/../../outside.cjs')).toThrow('outside the container')
  })
  it('exposes the same workspace import constructor for evaluated ESM',async()=>{
    const calls:string[][]=[]
    const loader=new BrowserCommonJS(undefined,async(specifier,from)=>{
      calls.push([specifier,from]);return {answer:5}
    })
    const Constructor=loader.createFunctionConstructor('/app/entry.mjs')
    const generated=new Constructor('specifier','return import(specifier)')
    expect(await generated('file:///app/value.mjs')).toEqual({answer:5})
    expect(calls).toEqual([['file:///app/value.mjs','/app/entry.mjs']])
    expect(new Constructor('value','return value+3')(2)).toBe(5)
  })
  it('honors extra conditions in exact and wildcard package exports',()=>{
    vol.fromJSON({
      '/app/entry.cjs':'module.exports=[require("condition-probe"),require("condition-probe/value")]',
      '/app/node_modules/condition-probe/package.json':JSON.stringify({exports:{
        '.':{development:'./dev.cjs',default:'./fallback.cjs'},
        './*':{development:'./dev-*.cjs',default:'./fallback.cjs'},
      }}),
      '/app/node_modules/condition-probe/dev.cjs':'module.exports="development"',
      '/app/node_modules/condition-probe/dev-value.cjs':'module.exports="development value"',
      '/app/node_modules/condition-probe/fallback.cjs':'module.exports="fallback"',
    })
    expect(new BrowserCommonJS(undefined,undefined,true,()=>['development']).load('/app/entry.cjs'))
      .toEqual(['development','development value'])
    expect(new BrowserCommonJS().load('/app/entry.cjs')).toEqual(['fallback','fallback'])
  })
  it('strips a Node CLI shebang before evaluating CommonJS',()=>{
    vol.fromJSON({'/app/cli.cjs':'#!/usr/bin/env node\nmodule.exports=42'})
    expect(new BrowserCommonJS().load('/app/cli.cjs')).toBe(42)
  })
  it('loads extensionless Node-shebang CommonJS executables',()=>{
    vol.fromJSON({'/app/node_modules/compiler/package.json':'{}',
      '/app/node_modules/compiler/bin/tsc':'#!/usr/bin/env node\nmodule.exports=require("../value.json").answer',
      '/app/node_modules/compiler/value.json':'{"answer":42}'})
    expect(new BrowserCommonJS().isCommonJS('/app/node_modules/compiler/bin/tsc')).toBe(true)
    expect(new BrowserCommonJS().load('/app/node_modules/compiler/bin/tsc')).toBe(42)
  })
  it('loads relative files, JSON, and cycles from the owned volume',()=>{
    vol.fromJSON({
      '/app/package.json':'{"type":"commonjs"}',
      '/app/a.js':'exports.name="a";const b=require("./b");exports.other=b.name;exports.cycle=b.other',
      '/app/b.js':'exports.name="b";exports.other=require("./a").name',
      '/app/config.json':'{"enabled":true}',
      '/app/entry.js':'module.exports={a:require("./a"),enabled:require("./config.json").enabled}',
    })
    const result=new BrowserCommonJS().load('/app/entry.js') as {a:{name:string,other:string,cycle:string},enabled:boolean}
    expect(result).toEqual({a:{name:'a',other:'b',cycle:'a'},enabled:true})
  })

  it('resolves installed package main and require exports without escaping the volume',()=>{
    vol.fromJSON({
      '/app/package.json':'{"type":"commonjs"}',
      '/app/entry.js':'module.exports={one:require("plain"),two:require("scoped/feature")}',
      '/app/node_modules/plain/package.json':'{"main":"lib/main.cjs"}',
      '/app/node_modules/plain/lib/main.cjs':'module.exports=41',
      '/app/node_modules/scoped/package.json':'{"exports":{"./feature":{"require":"./dist/feature.cjs"}}}',
      '/app/node_modules/scoped/dist/feature.cjs':'module.exports=42',
    })
    expect(new BrowserCommonJS().load('/app/entry.js')).toEqual({one:41,two:42})
    expect(()=>new BrowserCommonJS().load('/outside.js')).toThrow('outside the container filesystem')
  })

  it('uses a package browser entry when requiring its root',()=>{
    vol.fromJSON({
      '/app/entry.cjs':'module.exports=require("package-with-browser")',
      '/app/node_modules/package-with-browser/package.json':'{"main":"index.js","browser":"lib/browser.js"}',
      '/app/node_modules/package-with-browser/index.js':'module.exports="node"',
      '/app/node_modules/package-with-browser/lib/browser.js':'module.exports="browser"',
    })
    expect(new BrowserCommonJS().load('/app/entry.cjs')).toBe('browser')
  })

  it('provides Node process and timing builtins to CommonJS packages',()=>{
    vol.fromJSON({
      '/app/package.json':'{"type":"commonjs"}',
      '/app/entry.js':'module.exports={cwd:typeof require("node:process").cwd,clock:typeof require("node:perf_hooks").performance.now,timer:typeof require("node:timers").setTimeout}',
    })
    expect(new BrowserCommonJS().load('/app/entry.js')).toEqual({cwd:'function',clock:'function',timer:'function'})
  })

  it('provides VM to CommonJS packages',()=>{
    vol.fromJSON({
      '/app/package.json':'{"type":"commonjs"}',
      '/app/entry.js':'module.exports=typeof require("node:vm").runInNewContext',
    })
    expect(new BrowserCommonJS().load('/app/entry.js')).toBe('function')
  })

  it('routes CommonJS fs through the same live workspace methods as ESM',()=>{
    const fs=createRequire('file:///app/entry.cjs')('node:fs') as typeof liveFs
    expect(fs.readFileSync).toBe(liveFs.readFileSync)
    expect(fs.writeFileSync).toBe(liveFs.writeFileSync)
    expect(fs.statSync).toBe(liveFs.statSync)
  })

  it('returns the CommonJS module shape for Babel traverse',()=>{
    const babel=createRequire('file:///app/entry.js')('@babel/traverse') as {default:unknown}
    expect(typeof babel.default).toBe('function')
  })

  it('resolves package subpaths relative to the requiring module',()=>{
    vol.fromJSON({
      '/app/node_modules/plugin/dist/index.mjs':'',
      '/app/node_modules/plugin/node_modules/dependency/package.json':'{"main":"dist/main.js"}',
      '/app/node_modules/plugin/node_modules/dependency/dist/main.js':'',
      '/app/node_modules/plugin/node_modules/dependency/dist/runtime.mjs':'',
    })
    const require=createRequire('file:///app/node_modules/plugin/dist/index.mjs')
    expect(require.resolve('dependency')).toBe('/app/node_modules/plugin/node_modules/dependency/dist/main.js')
    expect(require.resolve('dependency/dist/runtime.mjs')).toBe('/app/node_modules/plugin/node_modules/dependency/dist/runtime.mjs')
  })

  it('loads installed CommonJS packages through createRequire from ESM',()=>{
    vol.fromJSON({
      '/app/package.json':'{"type":"module"}',
      '/app/node_modules/binding/package.json':'{"main":"index.cjs"}',
      '/app/node_modules/binding/index.cjs':'module.exports={value:require("./value.json").answer}',
      '/app/node_modules/binding/value.json':'{"answer":42}',
    })
    const require=createRequire('file:///app/server.mjs')
    expect(require('binding')).toEqual({value:42})
    expect(require('binding')).toBe(require('binding'))
  })

  it('uses the CommonJS main instead of an ESM browser entry for createRequire',()=>{
    vol.fromJSON({
      '/app/node_modules/binding/package.json':'{"main":"binding.cjs","browser":"binding-browser.js"}',
      '/app/node_modules/binding/binding.cjs':'module.exports=42',
      '/app/node_modules/binding/binding-browser.js':'export default 0',
    })
    expect(createRequire('file:///app/entry.mjs')('binding')).toBe(42)
  })

  it('does not treat type-only import text in comments as a dynamic import',()=>{
    vol.fromJSON({'/app/binding.cjs':"/** @type {typeof import('node:fs')} */\nmodule.exports=42"})
    expect(createRequire('file:///app/entry.mjs')('./binding.cjs')).toBe(42)
  })

  it('classifies the whole module-entry subtree as ESM',()=>{
    vol.fromJSON({
      '/app/node_modules/parser/package.json':'{"main":"./lib/umd/main.js","module":"./lib/esm/main.js"}',
      '/app/node_modules/parser/lib/umd/main.js':'module.exports=42',
      '/app/node_modules/parser/lib/esm/main.js':'export {value} from "./impl/value.js"',
      '/app/node_modules/parser/lib/esm/impl/value.js':'export const value=42',
      '/app/node_modules/parser/lib/esm/impl/generated.cjs.js':'module.exports=43',
    })
    const loader=new BrowserCommonJS()
    expect(loader.isCommonJS('/app/node_modules/parser/lib/umd/main.js')).toBe(true)
    expect(loader.isCommonJS('/app/node_modules/parser/lib/esm/impl/value.js')).toBe(false)
    expect(loader.isCommonJS('/app/node_modules/parser/lib/esm/impl/generated.cjs.js')).toBe(true)
  })
})
