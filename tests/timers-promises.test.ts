import {test,expect} from 'vitest'
import * as native from 'node:timers/promises'
// @ts-expect-error Guest implementation compared with Node.
import * as guest from '../src/sandbox/guest-timers-promises.js'
async function probe(api:any){
  const results=[await api.setTimeout(1,42),await api.setImmediate('immediate')]
  const signal=AbortSignal.abort('reason')
  for(const run of [()=>api.setTimeout(20,0,{signal}),()=>api.setImmediate(0,{signal}),()=>api.setInterval(20,0,{signal}).next()]){
    try{await run()}catch(error:any){results.push([error.name,error.code,error.cause])}
  }
  const controller=new AbortController(),pending=api.setTimeout(10000,0,{signal:controller.signal});controller.abort('later')
  try{await pending}catch(error:any){results.push([error.name,error.code,error.cause])}
  let count=0;for await(const value of api.setInterval(1,'tick')){results.push(value);if(++count===2)break}
  results.push(await api.scheduler.wait(1),await api.scheduler.yield())
  return results
}
test('promise timers match Node values, abort errors, interval iteration and scheduler',async()=>{
  expect(await probe(guest)).toEqual(await probe(native))
})
test('promise timers reject invalid options without leaving timers active',async()=>{
  for(const api of [guest,native])for(const options of [null,1,{ref:'yes'},{signal:{}}]){
    await expect(api.setTimeout(1,0,options as any)).rejects.toHaveProperty('code','ERR_INVALID_ARG_TYPE')
  }
})
