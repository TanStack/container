import {test,expect} from 'vitest'
import native from 'node:events'
// @ts-expect-error Compiler helper intentionally has no declaration file.
import {createEventsExtras} from '../src/compiler/events-extras.js'

const guest=createEventsExtras(native)
test('listener helpers, max listeners and abort cleanup match native shapes',async()=>{
  const emitter=new guest.EventEmitter(),fn=()=>{}
  emitter.on('x',fn);expect(guest.getEventListeners(emitter,'x')).toEqual([fn]);expect(guest.getMaxListeners(emitter)).toBe(native.getMaxListeners(new native.EventEmitter()))
  guest.setMaxListeners(3,emitter);expect(guest.getMaxListeners(emitter)).toBe(3)
  const controller=new AbortController(),seen:string[]=[];const disposable=guest.addAbortListener(controller.signal,()=>seen.push('abort'));controller.abort('stop');await Promise.resolve();expect(seen).toEqual(['abort']);disposable[Symbol.dispose]()
  expect(guest.captureRejectionSymbol).toBe(native.captureRejectionSymbol);expect(guest.errorMonitor.description).toBe(native.errorMonitor.description);expect(guest.usingDomains).toBe((native as any).usingDomains)
  const previous=guest.EventEmitter.defaultMaxListeners;guest.EventEmitter.defaultMaxListeners=4;expect(new guest.EventEmitter().getMaxListeners()).toBe(4);guest.EventEmitter.defaultMaxListeners=previous
  expect(()=>guest.EventEmitter.defaultMaxListeners=-1).toThrow(expect.objectContaining({code:'ERR_OUT_OF_RANGE'}))
})
test('capture rejection and error monitor route returned Promise failures',async()=>{
  const emitter=new guest.EventEmitter({captureRejections:true}),seen:string[]=[]
  emitter.on(guest.errorMonitor,(error:Error)=>seen.push('monitor:'+error.message));emitter.on('error',(error:Error)=>seen.push('error:'+error.message));emitter.on('work',async()=>{throw Error('failed')});emitter.emit('work');await new Promise(resolve=>setTimeout(resolve,0));expect(seen).toEqual(['monitor:failed','error:failed'])
  const custom=new guest.EventEmitter({captureRejections:true});custom[guest.captureRejectionSymbol]=(error:Error,name:string,value:number)=>seen.push([error.message,name,value].join(':'));custom.on('job',async()=>{throw Error('custom')});custom.emit('job',42);await new Promise(resolve=>setTimeout(resolve,0));expect(seen.at(-1)).toBe('custom:job:42')
})
test('async event iterator buffers, closes, propagates errors and aborts',async()=>{
  const emitter=new guest.EventEmitter(),iterator=guest.on(emitter,'data',{close:['close']});emitter.emit('data',1,2);expect(await iterator.next()).toEqual({value:[1,2],done:false});emitter.emit('close');expect(await iterator.next()).toEqual({value:undefined,done:true})
  const failed=new guest.EventEmitter(),failure=guest.on(failed,'data');failed.emit('error',Error('boom'));await expect(failure.next()).rejects.toThrow('boom')
  const controller=new AbortController(),aborted=guest.on(new guest.EventEmitter(),'data',{signal:controller.signal});controller.abort('stop');await expect(aborted.next()).rejects.toMatchObject({name:'AbortError',code:'ABORT_ERR',cause:'stop'})
  expect(()=>guest.on(new guest.EventEmitter(),'data',{highWaterMark:0})).toThrow(expect.objectContaining({code:'ERR_OUT_OF_RANGE'}))
})
