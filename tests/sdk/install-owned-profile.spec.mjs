import {test,expect,webkit} from '@playwright/test'
import {writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {startPackagedFrameworkDiagnostic} from './helpers/packaged-framework-diagnostic.mjs'
import {processSnapshot,sampleOwnedWebKit} from './helpers/owned-webkit-sample.mjs'

// Diagnostic only: unchanged SDK responses, normal Vite install, no retry.
// Native sampling happens only after the unchanged 60 second readiness limit.
test('diagnostic normal Vite install with owned WebKit failure samples',async({},info)=>{
  test.skip(info.project.name!=='webkit','WebKit-only diagnostic')
  test.skip(process.platform!=='darwin','Native process sampling requires macOS')
  const {host,evidence}=await startPackagedFrameworkDiagnostic('sdk-install-owned-profile-')
  let server,browser,page,anchor,ownershipUnavailable,failure,profile,output
  const errors=[],requests=[]
  try{
    server=await webkit.launchServer({headless:true})
    const child=server.process()
    try{anchor=(await processSnapshot()).find(row=>row.pid===child.pid);if(!anchor)ownershipUnavailable='Browser PID was absent from process snapshot'}catch(error){ownershipUnavailable=String(error)}
    browser=await webkit.connect(server.wsEndpoint())
    page=await browser.newPage()
    page.on('pageerror',error=>{if(errors.length<32)errors.push(String(error))})
    page.on('requestfinished',request=>{if(requests.length<256)requests.push({url:request.url(),at:Date.now()})})
    await page.goto(host.ownerOrigin)
    await page.locator('#project').selectOption('vite')
    await page.locator('#open').click()
    await expect(page.frameLocator('#preview iframe').locator('#message')).toHaveText('Hello from Vite',{timeout:60000})
  }catch(error){
    failure=error
    if(server)profile=await sampleOwnedWebKit({kind:'child',child:server.process(),anchor},dirname(webkit.executablePath()))
  }finally{
    output=await page?.locator('#output').textContent({timeout:1000}).catch(()=>null)
    const path=info.outputPath('install-owned-profile.json')
    try{
      await writeFile(path,JSON.stringify({diagnosticOnly:true,modifiedRuntime:false,...evidence,outcome:failure?'failed':'passed',failure:failure?String(failure):null,anchor,ownershipUnavailable,profile,errors,requests,output},null,2))
      await info.attach('install-owned-profile.json',{path,contentType:'application/json'})
    }finally{
      await browser?.close().catch(()=>{})
      await server?.close().catch(()=>{})
      await host.close()
    }
  }
  if(failure)throw failure
})
