import {it,expect,vi} from 'vitest'
import {readFileSync} from 'node:fs'
import {EventEmitter} from 'node:events'
import {fileURLToPath} from 'node:url'

it('propagates a launch error synchronously and rolls back prepared resources',()=>{
  const source=readFileSync('src/sandbox/guest-worker-threads.js','utf8')
  const start=source.indexOf('export class Worker extends EventEmitter')
  const end=source.indexOf('\n  postMessage(',start)
  const constructor=source.slice(start,end).replace('export class Worker','class Worker')+'\n};return Worker'
  const sentinel=Object.assign(Error('fixture launch failure'),{code:'EAGAIN'})
  const prepared={ports:[],shared:[],modules:[],text:'null',commit:vi.fn(),rollback:vi.fn()}
  const call=vi.fn((..._args:unknown[])=>{throw sentinel})
  const options=()=>({eval:false,argv:[],execArgv:[],env:{}})
  const normalize=(filename:string)=>({filename,dataURL:false})
  const Worker=new Function('EventEmitter','workerOptions','workerFilename','encodeTransferred','host','URL','fileURLToPath',constructor)(EventEmitter,options,normalize,()=>prepared,{proc:{call}},URL,fileURLToPath)
  let caught
  try{new Worker('/child.mjs')}catch(error){caught=error}
  expect(caught).toBe(sentinel)
  expect(call).toHaveBeenCalledTimes(1)
  expect(call.mock.calls[0][0]).toBe('workerSpawn')
  expect(prepared.rollback).toHaveBeenCalledTimes(1)
  expect(prepared.commit).not.toHaveBeenCalled()
})
