import {test,expect} from '@playwright/test'

test('preview policy covers mixed-case HTML and non-HTML responses',async({page,context})=>{
  const external:string[]=[]
  await context.route('https://example.invalid/**',route=>{external.push(route.request().url());return route.abort()})
  await page.goto('/sandbox.html')
  await page.evaluate(async()=>{
    const html=`<!doctype html><html><head><title>Policy probe</title></head><body><button id="control">Ready</button><script>
      document.body.dataset.executed='yes';
      window.blockedFetch=fetch('https://example.invalid/probe').then(()=>false,()=>true);
    </script></body></html>`
    const preview=await window.sandboxLab.URLPreview.mount(document.querySelector('#preview')!,{
      origin:'http://127.0.0.1:4200',
      server:{fetch:async request=>new URL(request.url).pathname==='/asset.svg'
        ?new Response(`<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[
          document.documentElement.setAttribute('data-executed','yes');
          fetch('https://example.invalid/svg-probe').then(
            ()=>document.documentElement.setAttribute('data-network','allowed'),
            ()=>document.documentElement.setAttribute('data-network','blocked'));
        ]]></script></svg>`,{headers:{'Content-Type':'image/svg+xml'}})
        :new Response(html,{headers:{'Content-Type':'TEXT/HTML; charset=UTF-8'}})},
    })
    Object.assign(window,{policyPreview:preview})
  })
  try{
    const frame=page.frameLocator('#preview iframe')
    await expect(frame.locator('body')).toHaveAttribute('data-executed','yes')
    const previewFrame=page.frames().find(frame=>frame.url()==='http://127.0.0.1:4200/')!
    const result=await previewFrame.evaluate(async()=>({
      blocked:await (window as any).blockedFetch,
      htmlPolicy:(await fetch('/')).headers.get('content-security-policy'),
      svgPolicy:(await fetch('/asset.svg')).headers.get('content-security-policy'),
      parentDenied:(()=>{try{void parent.document.title;return false}catch{return true}})(),
    }))
    expect(result.blocked).toBe(true)
    expect(result.parentDenied).toBe(true)
    expect(result.htmlPolicy).toContain("connect-src 'self'")
    expect(result.svgPolicy).toBe(result.htmlPolicy)
    await previewFrame.goto('http://127.0.0.1:4200/asset.svg')
    await expect(frame.locator('svg')).toHaveAttribute('data-executed','yes')
    await expect(frame.locator('svg')).toHaveAttribute('data-network','blocked')
    expect(external).toEqual([])
  }finally{await page.evaluate(()=>(window as any).policyPreview?.close())}
})
