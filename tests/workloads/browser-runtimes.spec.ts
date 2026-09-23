import {test,expect} from '@playwright/test'
for(const runtime of ['esbuild','rollup','sqlite','python']){
  test('browser-native '+runtime+' | separate trusted worker',async({page},info)=>{
    await page.goto('/sandbox.html')
    const unexpectedRequests:string[]=[]
    await page.route('**/*',route=>{
      const url=new URL(route.request().url())
      if(url.origin!=='http://127.0.0.1:4199'){unexpectedRequests.push(url.href);return route.abort()}
      return route.continue()
    })
    const report=await page.evaluate(runtime=>new Promise<any>((resolve,reject)=>{
      const worker=new Worker('/workloads/browser/worker.mjs?runtime='+runtime,{type:'module'})
      const timer=setTimeout(()=>{worker.terminate();reject(Error('Browser runtime timed out'))},90000)
      worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data)}
      worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(Error(event.message))}
    }),runtime)
    await info.attach('browser-runtime.json',{body:JSON.stringify(report),contentType:'application/json'})
    expect(unexpectedRequests).toEqual([])
    expect(report.status,report.error).toBe('adapted-pass')
    expect(report.values).toEqual([6,14,14,6])
    expect(report.crossOriginIsolated).toBe(false)
  })
}
