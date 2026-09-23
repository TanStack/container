import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

const bytes=Array.from(readFileSync('fixtures/wasm-simd/js-boundary.wasm'))
function exercise(api:typeof WebAssembly,bytes:number[]){
  let calls=0
  const {exports}=new api.Instance(new api.Module(new Uint8Array(bytes)),{env:{callback(){calls++;return 1}}})
  const errors=['argument','result','callback'].map(name=>{
    try{(exports[name] as Function)(undefined);return 'no error'}catch(error){return (error as Error).name}
  })
  return {errors,calls,ordinary:(exports.ordinary as Function)()}
}

test('vector signatures fail at the JS boundary before guest or callback execution',async({page})=>{
  const native=exercise(WebAssembly,bytes)
  expect(native).toEqual({errors:['TypeError','TypeError','TypeError'],calls:0,ordinary:42})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({bytes,source})=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.execute(`console.log(JSON.stringify((${source})(WebAssembly,${JSON.stringify(bytes)})))`,{guestWasm:true,timeoutMs:20000})}
    finally{kernel.close()}
  },{bytes,source:exercise.toString()})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(native)
})
