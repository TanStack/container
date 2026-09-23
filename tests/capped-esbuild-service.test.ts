import {test,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {Worker} from 'node:worker_threads'
import {createHash} from 'node:crypto'
import {applyWasmMemoryPolicy} from '../src/compiler/wasm-memory-policy'

test('version-matched capped compiler performs an ordinary TypeScript service transform',async()=>{
  const original=new Uint8Array(readFileSync('node_modules/esbuild-wasm/esbuild.wasm'))
  const prepared=applyWasmMemoryPolicy(original,1024)
  const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
  expect(hash(prepared.bytes)).not.toBe(hash(original))
  const worker=new Worker(new URL('./fixtures/capped-esbuild-service.worker.mjs',import.meta.url),{
    workerData:{bytes:prepared.bytes,source:'export const answer: number = 42;'},
    resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8},
  })
  let timer:ReturnType<typeof setTimeout>|undefined
  try{
    const result=await new Promise<any>((resolve,reject)=>{
      timer=setTimeout(()=>reject(Error('Compiler harness exceeded 10 seconds')),10000)
      worker.once('message',resolve);worker.once('error',reject)
      worker.once('exit',code=>reject(Error('Compiler worker exited before result: '+code)))
    })
    expect(result.error).toBeUndefined()
    expect(result.version).toBe('0.28.2')
    expect(result.code).toContain('const answer = 42')
    expect(result.code).not.toContain(': number')
    expect(result.warnings).toEqual([])
    expect(JSON.parse(result.map).sources).toEqual(['ordinary.ts'])
  }finally{clearTimeout(timer);await worker.terminate()}
},15000)
