import {EventEmitter} from 'node:events'
import {expect,test} from 'vitest'
import native from 'node:domain'
// @ts-expect-error The guest source intentionally has no host declaration file.
import * as guest from '../src/sandbox/guest-domain.js'

function exercise(api:any){
  const outer=api.create(),inner=api.create(),trace:any[]=[]
  trace.push(api.active??null)
  const value=outer.run(function(this:any){trace.push(api.active===outer,this===outer);return inner.run(()=>{trace.push(api.active===inner);return 7})})
  trace.push(value,api.active??null)
  const bound=outer.bind(function(this:any,value:number){trace.push(api.active===outer,this.tag);return value+1})
  trace.push(bound.call({tag:'receiver'},3))
  const errors:string[]=[];outer.on('error',(error:Error)=>errors.push(error.message))
  const intercepted=outer.intercept((value:number)=>{trace.push(api.active===outer);return value*2})
  trace.push(intercepted(null,5));intercepted(Error('callback error'),5)
  const member=new EventEmitter();outer.add(member);trace.push(outer.members.includes(member),(member as any).domain===outer);member.emit('error',Error('member error'));outer.remove(member);trace.push(outer.members.includes(member),(member as any).domain??null)
  return {trace,errors}
}

test('synchronous scopes, nesting, bind, intercept and membership match native Node',()=>{
  expect(exercise(guest as any)).toEqual(exercise(native))
})

test('promise values are preserved without claiming uncaught async error interception',async()=>{
  for(const api of [native,guest as any]){
    const domain=api.create()
    await expect(domain.run(async()=>{await Promise.resolve();return 42})).resolves.toBe(42)
    await expect(domain.bind(async(value:number)=>value+1)(4)).resolves.toBe(5)
  }
})

test('bind routes synchronous errors and dispose clears legacy membership',()=>{
  const domain=guest.create(),member=new EventEmitter(),errors:string[]=[]
  domain.on('error',(error:Error)=>errors.push(error.message));domain.add(member)
  expect(domain.bind(()=>{throw Error('bound failure')})()).toBeUndefined()
  expect(errors).toEqual(['bound failure'])
  domain.dispose()
  expect(domain.disposed).toBe(true);expect(domain.members).toEqual([]);expect((member as any).domain).toBeNull()
})
