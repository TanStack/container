import {test,expect} from '@playwright/test'

test('native direct and indirect tail dispatch control is bounded',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const bytes=await (await fetch('/guest-wasm/tail-dispatch.wasm')).arrayBuffer()
    const url=URL.createObjectURL(new Blob([`onmessage=async({data})=>{
      try{
        const {instance}=await WebAssembly.instantiate(data),rows=[];
        for(let n=0;n<100;n++)for(const name of ['mixed','mixedLoop'])
          if(instance.exports[name](n)!==42+(n%2)*2)throw Error('Mixed dispatch state mismatch');
        for(let round=0;round<3;round++)for(const name of ['direct','indirect','mixed','mixedLoop']){
          const start=performance.now(),answer=instance.exports[name](10000000);
          rows.push({name,round,answer,ms:performance.now()-start});
        }
        postMessage({rows});
      }catch(error){postMessage({error:String(error)})}
    }`],{type:'text/javascript'}))
    const worker=new Worker(url)
    try{return await new Promise<{error?:string;rows?:{name:string;round:number;answer:number;ms:number}[]}>((resolve,reject)=>{
      const timer=setTimeout(()=>{worker.terminate();reject(Error('Dispatch control timed out'))},15000)
      worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)}
      worker.onerror=event=>{clearTimeout(timer);reject(Error(event.message))}
      worker.postMessage(bytes,[bytes])
    })}finally{worker.terminate();URL.revokeObjectURL(url)}
  })
  await info.attach('native-tail-dispatch.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.error).toBeUndefined()
  expect(result.rows).toHaveLength(12)
  expect(result.rows!.every(row=>row.answer===42)).toBe(true)
  console.log(info.project.name,'native tail dispatch',result.rows)
})

test('native WASM host-crossing control uses a bounded dedicated worker',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const bytes=await (await fetch('/guest-wasm/host-crossing.wasm')).arrayBuffer()
    const source=`onmessage=async({data})=>{
      try{
        let calls=0;const deadline=performance.now()+10000;
        const {instance}=await WebAssembly.instantiate(data,{host:{check(){calls++;return performance.now()>deadline?1:0}}});
        const timings=[];
        for(let n=0;n<4;n++){
          const start=performance.now();
          if(instance.exports.run(195315)!==42)throw Error('Unexpected result');
          timings.push(performance.now()-start);
        }
        postMessage({calls,timings});
      }catch(error){postMessage({error:String(error)})}
    }`
    const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}))
    const worker=new Worker(url)
    try{
      return await new Promise<{calls?:number;timings?:number[];error?:string}>((resolve,reject)=>{
        const timer=setTimeout(()=>{worker.terminate();reject(Error('Control worker timed out'))},15000)
        worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)}
        worker.onerror=event=>{clearTimeout(timer);reject(Error(event.message))}
        worker.postMessage(bytes,[bytes])
      })
    }finally{worker.terminate();URL.revokeObjectURL(url)}
  })
  await info.attach('native-host-crossing.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.error).toBeUndefined()
  expect(result.calls).toBe(4*195315)
  expect(result.timings).toHaveLength(4)
  console.log(info.project.name,'native WASM host crossing milliseconds',result.timings)
})
