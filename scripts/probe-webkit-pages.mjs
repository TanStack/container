import {webkit} from '@playwright/test'
import {writeFile} from 'node:fs/promises'

// A diagnostic only. The animation variant changes one owned browser process,
// never system defaults, and does not change the workload or desktop gates.
const variant=process.argv[2]??'default'
if(!['default','no-window-animation'].includes(variant))throw Error('Unknown probe variant')
const bounded=async(promise,label)=>{
  let timer
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' exceeded 5 seconds')),5000)})])}
  finally{clearTimeout(timer)}
}
// Playwright's default argument validator rejects the separate NSUserDefaults
// value. In this diagnostic variant only, supply its normal WebKit arguments
// explicitly through the supported ignoreDefaultArgs option.
const launch=variant==='no-window-animation'?{headless:true,ignoreDefaultArgs:true,
  args:['--inspector-pipe','--headless','--no-startup-window','-NSAutomaticWindowAnimationsEnabled','NO']}:{headless:true}
const rows=[]
let error,server
try{
  server=await webkit.launchServer(launch)
  const browser=await webkit.connect(server.wsEndpoint())
  for(let i=0;i<110;i++){
    const started=performance.now(),row={iteration:i+1,stage:'context'};rows.push(row)
    try{
      const context=await bounded(browser.newContext(),'newContext')
      row.stage='page';const page=await bounded(context.newPage(),'newPage')
      row.stage='navigate';await page.goto('data:text/html,<h1>Blank page control</h1>',{timeout:5000})
      row.stage='verify';if(await page.locator('h1').textContent()!=='Blank page control')throw Error('Unexpected page')
      row.stage='close';await bounded(context.close(),'context.close')
      row.stage='passed';row.durationMs=performance.now()-started
      if((i+1)%10===0)console.log(variant,i+1,'blank contexts passed')
    }catch(e){row.error=String(e);row.durationMs=performance.now()-started;throw e}
  }
}catch(e){error=String(e);console.error(error)}finally{
  await server?.kill()
  await writeFile('reports/webkit-pages-'+variant+'.json',JSON.stringify({generatedAt:new Date().toISOString(),variant,
    scope:'Repeated isolated blank pages. No lab, QuickJS, compiler, package, worker, or network request.',
    status:error?'failed':'passed',error,rows},null,2)+'\n')
}
if(error)process.exitCode=1
