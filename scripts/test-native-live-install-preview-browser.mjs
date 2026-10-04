import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {chromium,firefox,webkit} from 'playwright'

const site=process.env.NATIVE_SITE_ORIGIN??'http://127.0.0.1:4338'
const owner=process.env.NATIVE_OWNER_ORIGIN??'http://127.0.0.1:4337'
const previewOrigin=process.env.NATIVE_PREVIEW_ORIGIN??'http://127.0.0.1:4339'
const rootLock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url)))
const pkg=rootLock.packages['node_modules/is-number']
assert.ok(pkg?.integrity&&pkg?.resolved)
const manifest=JSON.stringify({name:'live-preview-probe',version:'1.0.0',type:'module',
  scripts:{dev:'vite dev'},dependencies:{'is-number':pkg.version}})
const lock=JSON.stringify({name:'live-preview-probe',version:'1.0.0',lockfileVersion:3,requires:true,
  packages:{'':{name:'live-preview-probe',version:'1.0.0',dependencies:{'is-number':pkg.version}},
    'node_modules/is-number':pkg}})

for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
  if(process.env.NATIVE_BROWSER&&process.env.NATIVE_BROWSER!==name)continue
  const browser=await engine.launch({headless:true})
  try{
    const page=await browser.newPage()
    const errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    await page.goto(site+'/')
    await page.evaluate(async({owner,previewOrigin})=>{
      const {NativeOwnerClient,URLPreview}=await import('/sdk/index.js')
      const frame=document.createElement('iframe')
      frame.allow='cross-origin-isolated'
      document.body.append(frame)
      const ready=new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error('Owner frame did not load')),15000)
        window.addEventListener('message',function listener(event){
          if(event.source!==frame.contentWindow||event.origin!==owner||event.data!=='native-owner-ready')return
          clearTimeout(timeout);window.removeEventListener('message',listener);resolve()
        })
      })
      frame.src=owner+'/owner.html'
      await ready
      const client=await NativeOwnerClient.connect(frame.contentWindow,owner)
      await client.start({
        '/project/package.json':JSON.stringify({name:'live-preview-probe',version:'1.0.0',type:'module',scripts:{dev:'vite dev'}}),
        '/project/index.html':'<!doctype html><html><head></head><body><script type="module" src="/src.js"></script></body></html>',
        '/project/src.js':'document.body.textContent="ready"',
      },{workspaceRoot:'/project',startCommand:'pnpm run dev',installDependencies:false})
      const host=document.createElement('div')
      document.body.append(host)
      const preview=await URLPreview.mount(host,{origin:previewOrigin,
        server:{fetch:request=>client.fetch(request)},
        connectWebSocket:(url,protocols)=>client.connectWebSocket(previewOrigin,url,protocols)})
      const session=await client.openTerminalSession()
      window.liveInstallProbe={client,session,preview,frame,host}
    },{owner,previewOrigin})
    let previewFrame=page.frames().find(frame=>frame.url()===previewOrigin+'/')
    if(!previewFrame)previewFrame=await page.waitForEvent('framenavigated',{
      predicate:frame=>frame.url()===previewOrigin+'/',timeout:30000})
    await previewFrame.waitForFunction(()=>document.body?.textContent?.trim()==='ready',null,{timeout:30000})
    const result=await page.evaluate(async({manifest,lock})=>{
      const {client,session,preview}=window.liveInstallProbe
      const before=await session.runCommand('state=kept').result
      await client.writeFile('/project/package.json',manifest)
      await client.writeFile('/project/package-lock.json',lock)
      const install=await session.runCommand('pnpm install').result
      await client.writeFile('/project/src.js','import isNumber from "is-number"; document.body.textContent=String(isNumber(42))')
      preview.navigate('/')
      const after=await session.runCommand('printf "%s\\n" "$state"').result
      return {before,install,after}
    },{manifest,lock})
    try{
      await previewFrame.waitForFunction(()=>document.body?.textContent?.trim()==='true',null,{timeout:30000})
    }catch(error){
      throw Error(`${name} preview did not render after changed dependency install: ${JSON.stringify({body:await previewFrame.locator('body').innerText(),errors,result})}`,{cause:error})
    }finally{
      await page.evaluate(async()=>{
        const {client,session,preview,frame,host}=window.liveInstallProbe
        preview.close();await session.dispose();await client.dispose();client.close();frame.remove();host.remove()
      })
    }
    assert.equal(result.install.exitCode,0)
    assert.equal(result.after.stdout,'kept\n')
    console.log(name,'changed dependency install preserved shell and live preview')
  }finally{await browser.close()}
}
