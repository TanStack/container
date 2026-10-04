import {afterEach,expect,test,vi} from 'vitest'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Worker} from 'node:worker_threads'
import {Buffer} from 'node:buffer'
import {fork} from 'node:child_process'
import {Script} from 'node:vm'
import {answer} from './feature-value.js'

vi.mock('./feature-value.js',()=>({answer:42}))
test('VM async functions preserve receiver, signature and fresh evaluation identity',async()=>{
  const script=new Script('(async function named(value,extra=2){return {answer:value+extra,receiver:this.tag}})',{filename:'/app/async-function.js'})
  const first=script.runInThisContext(),second=script.runInThisContext()
  expect(first).not.toBe(second)
  expect(first.name).toBe('named')
  expect(first.length).toBe(1)
  expect(await first.call({tag:'owned'},40)).toEqual({answer:42,receiver:'owned'})
  const arrow=new Script('async (value)=>({value,global:this===globalThis})',{filename:'/app/async-arrow.js'}).runInThisContext()
  expect(await arrow.call({tag:'ignored'},42)).toEqual({value:42,global:true})
})
afterEach(()=>vi.useRealTimers())

test('module mocks replace the real export',()=>expect(answer).toBe(42))
test('runtime module mocks intercept dynamic imports',async()=>{
  vi.doMock('./feature-value.js',()=>({answer:43}))
  try{expect((await import('./feature-value.js')).answer).toBe(43)}
  finally{vi.doUnmock('./feature-value.js')}
})
test('function mocks record calls',()=>{
  const fn=vi.fn(value=>value+1)
  expect(fn(41)).toBe(42)
  expect(fn).toHaveBeenCalledWith(41)
})
test('awaited work finishes before assertions',async()=>{
  const value=await Promise.resolve(42)
  expect(value).toBe(42)
})
test('fake timers control delayed work',async()=>{
  vi.useFakeTimers()
  const fn=vi.fn()
  setTimeout(fn,100)
  expect(fn).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(100)
  expect(fn).toHaveBeenCalledOnce()
})
test('node filesystem writes can be read back',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vitest-features-'))
  try{
    const file=join(directory,'answer.txt')
    await writeFile(file,'42')
    expect(await readFile(file,'utf8')).toBe('42')
  }finally{await rm(directory,{recursive:true})}
})
test('importActual bypasses a registered module mock',async()=>{
  vi.doMock('./feature-value.js',()=>({answer:99}))
  try{
    expect((await vi.importActual('./feature-value.js')).answer).toBe(-1)
    expect((await import('./feature-value.js')).answer).toBe(99)
  }finally{vi.doUnmock('./feature-value.js')}
})
test('spies restore the original method',()=>{
  const object={answer:()=>42}
  const spy=vi.spyOn(object,'answer').mockReturnValue(7)
  expect(object.answer()).toBe(7)
  expect(spy).toHaveBeenCalledOnce()
  spy.mockRestore()
  expect(object.answer()).toBe(42)
})
test('inline snapshots serialize structured values',()=>{
  expect({answer:42,values:[1,2]}).toMatchInlineSnapshot(`
    {
      "answer": 42,
      "values": [
        1,
        2,
      ],
    }
  `)
})
test.concurrent.each([41,42])('concurrent asynchronous test %i',async value=>{
  const result=await new Promise(resolve=>setTimeout(()=>resolve(value),5))
  expect(result).toBe(value)
})
test('worker stdout preserves binary bytes and split UTF8 sequences',async()=>{
  const worker=new Worker(new URL('./output-probe.js',import.meta.url),{stdout:true,stderr:true})
  const chunks=[]
  worker.stdout.on('data',chunk=>chunks.push(chunk))
  await Promise.all([
    new Promise((resolve,reject)=>{worker.once('exit',code=>code===0?resolve():reject(Error(`Worker exited ${code}`)));worker.once('error',reject)}),
    new Promise(resolve=>worker.stdout.once('end',resolve)),
  ])
  expect([...Buffer.concat(chunks)]).toEqual([0xff,0,0xf0,0x9f,0x98,0x80])
})
test('fork stdout preserves binary bytes and split UTF8 sequences',async()=>{
  const child=fork(new URL('./output-probe.js',import.meta.url),[],{silent:true})
  const chunks=[]
  child.stdout.on('data',chunk=>chunks.push(chunk))
  await Promise.all([
    new Promise((resolve,reject)=>{child.once('exit',code=>code===0?resolve():reject(Error(`Child exited ${code}`)));child.once('error',reject)}),
    new Promise(resolve=>child.stdout.once('end',resolve)),
  ])
  expect([...Buffer.concat(chunks)]).toEqual([0xff,0,0xf0,0x9f,0x98,0x80])
})
test('data URL workers use container builtins and module metadata',async()=>{
  const url='data:text/javascript,'+encodeURIComponent('import {parentPort} from "node:worker_threads";await Promise.resolve();parentPort.postMessage({answer:42,url:import.meta.url});parentPort.close();')+'#vitest'
  const result=await new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(url));let message
    worker.on('message',value=>message=value);worker.on('error',reject)
    worker.on('exit',code=>code?reject(Error('worker exit '+code)):resolve(message))
  })
  expect(result).toEqual({answer:42,url})
})
test('default forks inherit descriptors without requiring silent pipes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vitest-fork-default-'))
  try{
    const entry=join(directory,'child.cjs')
    await writeFile(entry,'process.send({answer:42},()=>process.disconnect())')
    const result=await new Promise((resolve,reject)=>{
      const child=fork(entry,[],{execArgv:[]});let message
      expect([child.stdin,child.stdout,child.stderr]).toEqual([null,null,null])
      child.on('message',value=>message=value);child.on('error',reject)
      child.on('close',code=>code?reject(Error('child exit '+code)):resolve(message))
    })
    expect(result).toEqual({answer:42})
  }finally{await rm(directory,{recursive:true})}
})
