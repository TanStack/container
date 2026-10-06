import {describe,expect,it} from 'vitest'
import {browserCommonJSDefines,browserCommonJSDependencies} from '../src/native/browser-commonjs-source'
import {prepareBrowserCommonJSSource} from '../src/native/browser-commonjs-compiler'

const id='/app/node_modules/sample/index.js'
const choose=`if(process.env.NODE_ENV==='production'){module.exports=require('./production.js')}
else{module.exports=require('./development.js')}`
const prepare=(source:string,defines=browserCommonJSDefines({},'development'))=>prepareBrowserCommonJSSource(source,id,defines)
function execute(source:string,process={env:{NODE_ENV:'development'}},globals:Record<string,unknown>={}){
  const calls:string[]=[],module={exports:{} as any}
  Function('module','exports','require','process',...Object.keys(globals),source)(module,module.exports,
    (name:string)=>{calls.push(name);return name},process,...Object.values(globals))
  return {calls,exports:module.exports}
}

describe('client CommonJS build-time branch selection',()=>{
  it('removes only the inactive environment dependency before static import collection',()=>{
    expect(browserCommonJSDependencies(choose,id)).toEqual(['./production.js','./development.js'])
    const source=prepare(choose)
    expect(browserCommonJSDependencies(source,id)).toEqual(['./development.js'])
    expect(execute(source)).toEqual(execute(choose))
  })
  it('honors explicit production values instead of hardcoding development',()=>{
    const source=prepare(choose,browserCommonJSDefines({'process.env.NODE_ENV':'"production"'},'development'))
    expect(browserCommonJSDependencies(source,id)).toEqual(['./production.js'])
    expect(execute(source)).toEqual(execute(choose,{env:{NODE_ENV:'production'}}))
  })
  it('supports literal user flags in ternaries and short-circuit branches',()=>{
    const source=prepare(`module.exports=FEATURE?require('on'):require('off'); FEATURE&&require('extra')`,
      browserCommonJSDefines({FEATURE:'false'},'development'))
    expect(browserCommonJSDependencies(source,id)).toEqual(['off'])
    expect(execute(source)).toEqual(execute(`module.exports=FEATURE?require('on'):require('off'); FEATURE&&require('extra')`,undefined,{FEATURE:false}))
  })
  it('retains both dependencies for unknown conditions and non-literal defines',()=>{
    const source=`module.exports=chooseMode()?require('a'):require('b')`
    expect(prepare(source,browserCommonJSDefines({chooseMode:'customFunction'},'development'))).toBe(source)
    expect(browserCommonJSDependencies(source,id)).toEqual(['a','b'])
    const definitions=browserCommonJSDefines({'process.env.NODE_ENV':'chooseMode()'},'development')
    expect(Object.keys(definitions)).toHaveLength(0)
    expect(prepare(choose,definitions)).toBe(choose)
  })
  it('does not freeze process environment when the environment explicitly keeps it',()=>{
    const defines=browserCommonJSDefines({},'development',{keepProcessEnv:true})
    expect(defines).toEqual({});expect(prepare(choose,defines)).toBe(choose)
  })
  it('preserves shadowed process and require bindings',()=>{
    const source=`function local(process){return process.env.NODE_ENV==='production'?require('prod'):require('dev')}
module.exports=local({env:{NODE_ENV:'production'}});function other(require){return require('not-a-dependency')}`
    const result=prepare(source)
    expect(browserCommonJSDependencies(result,id)).toEqual(['prod','dev'])
    expect(execute(result)).toEqual(execute(source))
  })
  it('preserves hoisted declarations from unreachable branches',()=>{
    const source=choose.replace("module.exports=require('./production.js')","var hidden=3;module.exports=require('./production.js')")+';exports.hidden=hidden'
    expect(execute(prepare(source))).toEqual(execute(source))
    expect(browserCommonJSDependencies(prepare(source),id)).toEqual(['./development.js'])
  })
  it('preserves getters, side effects, console, debugger and function names',()=>{
    const source=`${choose}; let count=0;const obj={get value(){count++;return 1}};obj.value;
console.log('keep');debugger;function named(){};module.exports={count,name:named.name}`
    const logs:string[]=[],console={log:(value:string)=>logs.push(value)}
    const expected=execute(source,undefined,{console});logs.length=0
    const result=prepare(source)
    expect(execute(result,undefined,{console})).toEqual(expected)
    expect(logs).toEqual(['keep']);expect(result).toContain('debugger')
  })
  it('does not drop side effects marked pure by an annotation',()=>{
    const source=`${choose};/*@__PURE__*/ touch();`
    let count=0;execute(prepare(source),undefined,{touch:()=>count++})
    expect(count).toBe(1)
  })
  it('preserves eval-visible declarations and top-level CommonJS return',()=>{
    const source=`${choose};var visible=42;module.exports=eval('visible');return;require('unreachable')`
    expect(execute(prepare(source))).toEqual(execute(source))
  })
  it('does not rewrite comments or strings which mention defined expressions',()=>{
    const source=`${choose};exports.label='process.env.NODE_ENV';/* process.env.NODE_ENV */`
    expect(execute(prepare(source))).toEqual(execute(source))
  })
  it('keeps legal comments and reports malformed source rather than silently falling back',()=>{
    expect(prepare('/*! @license MIT */'+choose)).toContain('@license MIT')
    expect(()=>prepare('if(process.env.NODE_ENV {')).toThrow('CommonJS define transform failed')
  })
})
