import {readFileSync} from 'node:fs'
import {describe,it,expect} from 'vitest'

const source=readFileSync(new URL('../src/sandbox/guest-fs-descriptors.js',import.meta.url),'utf8')
const taskQueue=readFileSync(new URL('../src/sandbox/guest-task-queue.js',import.meta.url),'utf8')
const api=(host:Record<string,unknown>)=>new Function('globalThis',taskQueue+'\n'+source+';return descriptorAPI')({__webContainerHost:host,Symbol})

describe('filesystem task dispatch',()=>{
  it('waits for host task admission before performing work and preserves errors',async()=>{
    let release!:()=>void
    const host={filesystemTask:()=>new Promise<void>(resolve=>{release=resolve})}
    const fs=api(host),events:string[]=[]
    const operation=fs.task(()=>{events.push('file');return 42})
    await Promise.resolve();expect(events).toEqual([])
    release();expect(await operation).toBe(42);expect(events).toEqual(['file'])
    const error=Object.assign(Error('missing'),{code:'ENOENT'})
    const rejected=fs.task(()=>{throw error})
    release();await expect(rejected).rejects.toBe(error)
  })
  it('reports callback exceptions once instead of invoking the callback again',async()=>{
    let release!:()=>void
    const errors:unknown[]=[],host={filesystemTask:()=>new Promise<void>(resolve=>{release=resolve}),reportError:(error:unknown)=>errors.push(error)}
    const fs=api(host),error=Error('callback failed');let calls=0
    fs.dispatch(()=>{calls++;throw error})
    expect(calls).toBe(0);release()
    await new Promise<void>(resolve=>queueMicrotask(resolve))
    await new Promise<void>(resolve=>queueMicrotask(resolve))
    expect(calls).toBe(1);expect(errors).toEqual([error])
  })
})
