import {test,expect} from 'vitest'
import nativeConsole,{Console as NativeConsole} from 'node:console'
import {Writable} from 'node:stream'
// @ts-expect-error Guest JavaScript is tested directly against Node here.
import guestConsole,{Console} from '../src/sandbox/guest-console.js'

function capture(Constructor:any){
  const out:string[]=[],err:string[]=[]
  const stdout=new Writable({write(chunk,_encoding,done){out.push(String(chunk));done()}})
  const stderr=new Writable({write(chunk,_encoding,done){err.push(String(chunk));done()}})
  const c=new Constructor({stdout,stderr,colorMode:false,inspectOptions:{depth:1}})
  const {log,warn}=c
  log('%s %d %j','hello',42,{a:1});warn('bad',3)
  c.info({nested:{child:{value:1}}});c.debug('debug');c.error('error')
  c.assert(true,'hidden');c.assert(false,'value %d',2);c.assert(false)
  c.dir({a:{b:2}},{depth:0});c.dirxml('xml')
  return {out,err}
}
test('Console routes and formats stream output like Node with bound methods',()=>{
  expect(capture(Console)).toEqual(capture(NativeConsole))
})
test('Console validates streams and honors synchronous ignoreErrors',()=>{
  for(const Constructor of [Console,NativeConsole]){
    expect(()=>new Constructor()).toThrow()
    const makeStream=()=>{const stream=new Writable();stream.write=()=>{throw Error('write failed')};return stream}
    expect(()=>new Constructor({stdout:makeStream(),ignoreErrors:false}).log('x')).toThrow('write failed')
    expect(()=>new Constructor({stdout:makeStream()}).log('x')).not.toThrow()
  }
})
test('Console ignores asynchronous stream failures by default',async()=>{
  for(const Constructor of [Console,NativeConsole]){
    const stream=new Writable({write(_chunk,_encoding,done){done(Error('failed'))}})
    new Constructor({stdout:stream}).log('test')
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(stream.destroyed).toBe(true)
  }
})
function captureMethods(Constructor:any){
  const out:string[]=[],err:string[]=[]
  const stream=(target:string[])=>new Writable({write(chunk,_encoding,done){target.push(String(chunk));done()}})
  const value=new Constructor({stdout:stream(out),stderr:stream(err),colorMode:false})
  value.count();value.count('jobs');value.count('jobs');value.countReset('jobs');value.count('jobs')
  value.group('outer');value.log('inside');value.group('inner');value.warn('warning');value.groupEnd();value.groupEnd()
  value.table([{name:'Ada',score:2},{name:'Lin'}])
  value.table({ready:true,total:3})
  value.table(new Map<string,unknown>([['ready',true],['details',{total:3}]]))
  value.table(new Set(['ready','done']))
  value.clear()
  return{out,err}
}
test('Console counters, groups, tables and clear match deterministic native output',()=>{
  expect(captureMethods(Console)).toEqual(captureMethods(NativeConsole))
})
test('Console timers and traces use the native output shapes',async()=>{
  for(const Constructor of [Console,NativeConsole]){
    const out:string[]=[],err:string[]=[]
    const stream=(target:string[])=>new Writable({write(chunk,_encoding,done){target.push(String(chunk));done()}})
    const value=new Constructor({stdout:stream(out),stderr:stream(err),colorMode:false})
    value.time('work');await new Promise(resolve=>setTimeout(resolve,2));value.timeLog('work','step');value.timeEnd('work')
    value.trace('problem %d',2)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatch(/^work: \d+(?:\.\d{1,3})?ms step\n$/)
    expect(out[1]).toMatch(/^work: \d+(?:\.\d{1,3})?ms\n$/)
    expect(err[0]?.split('\n')[0]).toBe('Trace: problem 2')
  }
})
test('module console exposes native-shaped inspector hooks and tasks',()=>{
  expect(Object.keys(guestConsole).sort()).toEqual(Object.keys(nativeConsole).sort())
  for(const value of [guestConsole,nativeConsole]){
    expect(value.profile('profile')).toBeUndefined()
    expect(value.profileEnd('profile')).toBeUndefined()
    expect(value.timeStamp('mark')).toBeUndefined()
    expect(value.context('context')).not.toBe(value)
    expect(value.context('context').log('hidden')).toBeUndefined()
    const task=value.createTask('task')
    expect(task.run(()=>42)).toBe(42)
    expect(()=>task.run(null as never)).toThrow('First argument must be a function.')
    expect(()=>value.createTask('')).toThrow('First argument must be a non-empty string.')
  }
})
