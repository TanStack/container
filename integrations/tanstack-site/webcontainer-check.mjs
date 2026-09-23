import {chromium} from '@playwright/test'
const browser=await chromium.launch({headless:true})
const context=await browser.newContext({viewport:{width:1440,height:1000}})
const page=await context.newPage()
const started=performance.now(),events=[]
const stamp=(name,detail={})=>events.push({name,ms:Math.round((performance.now()-started)*1000)/1000,...detail})
page.on('pageerror',error=>stamp('pageerror',{error:String(error)}))
page.on('console',message=>{if(message.type()==='error')stamp('console-error',{text:message.text().slice(0,500)})})
page.on('requestfailed',request=>{const url=new URL(request.url());if(!url.pathname.includes('/collect'))stamp('request-failed',{url:url.origin+url.pathname,error:request.failure()?.errorText})})
page.on('frameattached',()=>stamp('frame-attached'))
page.on('framenavigated',frame=>{if(frame!==page.mainFrame())stamp('frame-navigated',{url:frame.url()})})
try{
  await page.goto(process.env.TANSTACK_WEBCONTAINER_URL??'http://127.0.0.1:4200/start/latest/docs/framework/react/examples/start-counter?panel=sandbox',{waitUntil:'domcontentloaded',timeout:120000})
  stamp('owner-dom-content-loaded')
  await page.waitForFunction(()=>document.body.innerText.includes('Add 1 to {state}?'),undefined,{timeout:120000})
  stamp('source-visible')
  const deadline=Date.now()+180000
  let target
  while(Date.now()<deadline&&!target){
    for(const frame of page.frames()){
      if(frame===page.mainFrame())continue
      const button=frame.getByRole('button',{name:'Add 1 to 0?',exact:true})
      if(await button.count().catch(()=>0)){target=frame;break}
    }
    if(!target)await page.waitForTimeout(100)
  }
  if(!target)throw Error('No Start preview button within 180 seconds')
  stamp('ssr-button-visible',{url:target.url()})
  await target.waitForFunction(()=>{const x=window.$_TSR;return x?.hydrated===true&&x?.streamEnded===true},undefined,{timeout:30000})
  stamp('hydrated')
  await target.getByRole('button',{name:'Add 1 to 0?',exact:true}).click()
  await target.getByRole('button',{name:'Add 1 to 1?',exact:true}).waitFor({timeout:30000})
  stamp('server-function-click')
  console.log(JSON.stringify({passed:true,events,frames:page.frames().map(frame=>frame.url()),body:(await page.locator('body').innerText()).slice(-4000)},null,2))
}catch(error){console.log(JSON.stringify({passed:false,error:String(error),events,frames:page.frames().map(frame=>frame.url()),body:(await page.locator('body').innerText().catch(()=>'' )).slice(-8000)},null,2));process.exitCode=1}
finally{await browser.close()}
