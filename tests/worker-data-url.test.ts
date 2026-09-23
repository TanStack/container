import {test,expect} from 'vitest'
import {Worker} from 'node:worker_threads'
import {dataModuleSource} from '../src/sandbox/data-module'

const run=(url:URL)=>new Promise((resolve,reject)=>{
  const worker=new Worker(url,{execArgv:[]})
  worker.once('message',resolve);worker.once('error',reject)
})
for(const base64 of [false,true])test(`data worker decoding matches Node (${base64?'base64':'percent'})`,async()=>{
  const source=`import {parentPort} from 'node:worker_threads';parentPort.postMessage({text:'café 😀',url:import.meta.url,filename:typeof import.meta.filename});`
  const url=new URL('data:text/javascript'+(base64?';base64,':',')+(base64?Buffer.from(source).toString('base64'):encodeURIComponent(source)))
  expect(dataModuleSource(url.href)).toBe(source)
  expect(await run(url)).toEqual({text:'café 😀',url:url.href,filename:'undefined'})
})
test('data MIME and relative import rejection are native controls',async()=>{
  expect(()=>dataModuleSource('data:text/plain,hello')).toThrow('MIME')
  await expect(run(new URL('data:text/plain,hello'))).rejects.toMatchObject({code:'ERR_UNKNOWN_MODULE_FORMAT'})
  await expect(run(new URL('data:text/javascript,import "./relative.mjs"'))).rejects.toMatchObject({code:'ERR_UNSUPPORTED_RESOLVE_REQUEST'})
})
