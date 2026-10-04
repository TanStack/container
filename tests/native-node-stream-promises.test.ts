import {expect,test} from 'vitest'
import {Writable} from 'stream-browserify'
import {pipeline,finished} from '../src/vite-browser/node-stream-promises'

test('pipelines a Web readable into a Node-style writable',async()=>{
  const chunks:Uint8Array[]=[]
  const writable=new Writable({write(chunk:Uint8Array,_encoding:string,callback:(error?:Error)=>void){chunks.push(new Uint8Array(chunk));callback()}})
  writable.once('finish',()=>writable.emit('close'))
  const source=new ReadableStream<Uint8Array>({start(controller){
    controller.enqueue(new TextEncoder().encode('one '))
    controller.enqueue(new TextEncoder().encode('two'))
    controller.close()
  }})
  expect(await pipeline(source,writable)).toBeUndefined()
  expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe('one two')
  // Node pipeline keeps terminal listeners to observe late stream failures.
  expect(writable.listenerCount('error')).toBeGreaterThan(0)
  expect(writable.listenerCount('close')).toBeGreaterThan(0)
})

test('rejects a Web-to-Node pipeline when the writable fails',async()=>{
  const failure=new Error('write failed')
  const writable=new Writable({write(_chunk:Uint8Array,_encoding:string,callback:(error?:Error)=>void){callback(failure)}})
  const source=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([1]));controller.close()}})
  await expect(pipeline(source,writable)).rejects.toThrow('write failed')
})

test('observes destination failure while the Web source is waiting for data',async()=>{
  const failure=Error('destination closed while reading')
  const writable=new Writable({write(_chunk:Uint8Array,_encoding:string,callback:()=>void){callback()}})
  writable.on('error',()=>{})
  let cancelled=false
  const source=new ReadableStream<Uint8Array>({cancel(){cancelled=true}})
  const result=pipeline(source,writable)
  writable.destroy(failure)
  let timeout:ReturnType<typeof setTimeout>|undefined
  try{
    await expect(Promise.race([result,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('pipeline stalled')),50)})])).rejects.toThrow(failure.message)
    expect(cancelled).toBe(true)
    expect(source.locked).toBe(false)
  }finally{clearTimeout(timeout);await source.cancel().catch(()=>{})}
})

test('destroys the destination when the Web source fails',async()=>{
  const failure=Error('source failed')
  const source=new ReadableStream<Uint8Array>({start(controller){controller.error(failure)}})
  const destination=new Writable({write(chunk:Uint8Array,encoding:string,done:()=>void){done()}})
  await expect(pipeline(source,destination)).rejects.toBe(failure)
  expect(destination.destroyed).toBe(true)
  expect(source.locked).toBe(false)
})

test('supports AbortSignal options while the Web reader is waiting',async()=>{
  const controller=new AbortController()
  let cancelled=false
  const source=new ReadableStream<Uint8Array>({cancel(){cancelled=true}})
  const destination=new Writable({write(chunk:Uint8Array,encoding:string,done:()=>void){done()}})
  const running=pipeline(source,destination,{signal:controller.signal})
  controller.abort()
  await expect(running).rejects.toMatchObject({name:'AbortError',code:'ABORT_ERR'})
  expect(cancelled).toBe(true)
  expect(source.locked).toBe(false)
  expect(destination.destroyed).toBe(true)
})

test('releases the Web reader when pipeline options are invalid',async()=>{
  const source=new ReadableStream<Uint8Array>()
  const destination=new Writable({write(chunk:Uint8Array,encoding:string,done:()=>void){done()}})
  await expect(pipeline(source,destination,{signal:42})).rejects.toMatchObject({code:'ERR_INVALID_ARG_TYPE'})
  expect(source.locked).toBe(false)
})

test('keeps the destination open with end false',async()=>{
  const chunks:Uint8Array[]=[]
  const source=new ReadableStream<Uint8Array>({start(controller){
    controller.enqueue(new Uint8Array([1]))
    controller.close()
  }})
  const destination=new Writable({write(chunk:Uint8Array,_encoding:string,done:()=>void){
    chunks.push(new Uint8Array(chunk))
    done()
  }})
  await pipeline(source,destination,{end:false})
  expect(source.locked).toBe(false)
  expect(destination.destroyed).toBe(false)
  expect(destination.writableEnded).not.toBe(true)
  destination.write(new Uint8Array([2]))
  destination.end()
  expect(Array.from(Buffer.concat(chunks))).toEqual([1,2])
})

test('finished honors abort without destroying the observed stream',async()=>{
  const controller=new AbortController()
  const destination=new Writable({write(_chunk:Uint8Array,_encoding:string,done:()=>void){done()}})
  const running=finished(destination,{signal:controller.signal,cleanup:true})
  controller.abort()
  await expect(running).rejects.toMatchObject({code:'ABORT_ERR'})
  expect(destination.destroyed).toBe(false)
  expect(destination.listenerCount('error')).toBe(0)
  expect(destination.listenerCount('close')).toBe(0)
  destination.end()
})

test('finished removes observation listeners when cleanup is requested',async()=>{
  const destination=new Writable({write(_chunk:Uint8Array,_encoding:string,done:()=>void){done()}})
  const running=finished(destination,{cleanup:true})
  destination.end()
  await running
  expect(destination.listenerCount('error')).toBe(0)
  expect(destination.listenerCount('close')).toBe(0)
})
