import {test,expect} from '@playwright/test'

test('preview inspection connects before a pending app module resolves',async({page})=>{
  await page.goto('/sandbox.html')
  try{
    const state=await page.evaluate(async()=>{
      let release!:()=>void
      const pending=new Promise<void>(resolve=>release=resolve)
      Object.assign(window,{releasePreviewModule:release})
      const preview=await window.sandboxLab.URLPreview.mount(document.querySelector('#preview')!,{
        origin:'http://127.0.0.1:4200',
        server:{fetch:async request=>{
          if(new URL(request.url).pathname==='/app.js'){
            await pending
            return new Response('document.body.dataset.appReady="true"',{headers:{'Content-Type':'text/javascript'}})
          }
          return new Response('<html><head><title>Pending module</title></head><body><p>Document parsed</p><script type="module" src="/app.js"></script></body></html>',{headers:{'Content-Type':'text/html'}})
        }},
      })
      Object.assign(window,{documentReadyPreview:preview})
      return await preview.inspect()
    })
    expect(state.text).toContain('Document parsed')
    const frame=page.frameLocator('#preview iframe')
    await expect(frame.locator('body')).not.toHaveAttribute('data-app-ready','true')
    await page.evaluate(()=>(window as any).releasePreviewModule())
    await expect(frame.locator('body')).toHaveAttribute('data-app-ready','true')
  }finally{
    await page.evaluate(()=>{(window as any).releasePreviewModule?.();(window as any).documentReadyPreview?.close()})
  }
})
