import {test,expect} from '@playwright/test'

test('closing a preview aborts an in-flight server request',async({page})=>{
  await page.goto('/sandbox.html')
  try{
    await page.evaluate(async()=>{
      Object.assign(window,{requestStarted:false,requestAborted:false})
      const server={async fetch(request:Request):Promise<Response>{
        if(new URL(request.url).pathname==='/pending'){
          ;(window as any).requestStarted=true
          return new Promise((_,reject)=>request.signal.addEventListener('abort',()=>{
            ;(window as any).requestAborted=true
            reject(request.signal.reason)
          },{once:true}))
        }
        return new Response('<html><head></head><body><script>fetch("/pending").catch(()=>{})</script></body></html>',{headers:{'Content-Type':'text/html'}})
      }}
      ;(window as any).budgetPreview=await window.sandboxLab.URLPreview.mount(document.querySelector('#preview')!,{origin:'http://127.0.0.1:4200',server})
    })
    await expect.poll(()=>page.evaluate(()=>(window as any).requestStarted)).toBe(true)
    await page.evaluate(()=>(window as any).budgetPreview.close())
    await expect.poll(()=>page.evaluate(()=>(window as any).requestAborted)).toBe(true)
  }finally{await page.evaluate(()=>(window as any).budgetPreview?.close()).catch(()=>{})}
})

test('preview allows a response inside the guest HTTP request budget',async({page},info)=>{
  await page.goto('/sandbox.html')
  try{
    await page.evaluate(async()=>{
      const server={async fetch(request:Request){
        if(new URL(request.url).pathname==='/slow'){
          await new Promise(resolve=>setTimeout(resolve,16000))
          return new Response('ready')
        }
        return new Response('<html><head></head><body><output id="result">waiting</output><script>fetch("/slow").then(async r=>{document.querySelector("#result").textContent=JSON.stringify({status:r.status,body:await r.text()})})</script></body></html>',{headers:{'Content-Type':'text/html'}})
      }}
      ;(window as any).budgetPreview=await window.sandboxLab.URLPreview.mount(document.querySelector('#preview')!,{origin:'http://127.0.0.1:4200',server})
    })
    const output=page.frameLocator('#preview iframe').locator('#result')
    await expect(output).not.toHaveText('waiting',{timeout:25000})
    const result=JSON.parse((await output.textContent())!)
    await info.attach('preview-request-budget.json',{body:JSON.stringify(result),contentType:'application/json'})
    expect(result).toEqual({status:200,body:'ready'})
  }finally{await page.evaluate(()=>(window as any).budgetPreview?.close()).catch(()=>{})}
})

test('preview keeps a slow first compilation bounded without using the old 30 second cutoff',async({page},info)=>{
  await page.goto('/sandbox.html')
  try{
    await page.evaluate(async()=>{
      const started=performance.now()
      const server={async fetch(request:Request){
        if(new URL(request.url).pathname==='/first-compile'){
          await new Promise(resolve=>setTimeout(resolve,31000))
          return new Response('compiled')
        }
        return new Response(`<html><head></head><body><output id="result">waiting</output><script>
          fetch('/first-compile').then(async response=>{
            document.querySelector('#result').textContent=JSON.stringify({status:response.status,body:await response.text(),elapsed:performance.now()-${started}})
          })
        </script></body></html>`,{headers:{'Content-Type':'text/html'}})
      }}
      ;(window as any).budgetPreview=await window.sandboxLab.URLPreview.mount(document.querySelector('#preview')!,{origin:'http://127.0.0.1:4200',server})
    })
    const output=page.frameLocator('#preview iframe').locator('#result')
    await expect(output).not.toHaveText('waiting',{timeout:45000})
    const result=JSON.parse((await output.textContent())!)
    await info.attach('preview-first-compile-budget.json',{body:JSON.stringify(result),contentType:'application/json'})
    expect(result.status).toBe(200)
    expect(result.body).toBe('compiled')
    expect(result.elapsed).toBeGreaterThanOrEqual(30000)
    expect(result.elapsed).toBeLessThan(60000)
  }finally{await page.evaluate(()=>(window as any).budgetPreview?.close()).catch(()=>{})}
})
