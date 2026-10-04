import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {chromium,firefox,webkit} from 'playwright'

const site=process.env.NATIVE_SITE_ORIGIN??'http://127.0.0.1:4298'
const owner=process.env.NATIVE_OWNER_ORIGIN??'http://127.0.0.1:4297'
const rootLock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url)))
const pkg=rootLock.packages['node_modules/is-number']
assert.ok(pkg?.integrity&&pkg?.resolved)
const manifest=JSON.stringify({name:'live-install-probe',version:'1.0.0',type:'module',
  scripts:{dev:'vite dev'},dependencies:{'is-number':pkg.version}})
const lock=JSON.stringify({name:'live-install-probe',version:'1.0.0',lockfileVersion:3,requires:true,
  packages:{'':{name:'live-install-probe',version:'1.0.0',dependencies:{'is-number':pkg.version}},
    'node_modules/is-number':pkg}})

for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
  const browser=await engine.launch({headless:true})
  try{
    const page=await browser.newPage()
    page.on('pageerror',error=>console.error(name,'pageerror',error.message))
    await page.goto(site+'/')
    const result=await page.evaluate(async({owner,manifest,lock})=>{
      const {NativeOwnerClient}=await import('/sdk/index.js')
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
      try{
        await client.start({
          '/project/package.json':JSON.stringify({name:'live-install-probe',version:'1.0.0',type:'module',scripts:{dev:'vite dev'}}),
          '/project/index.html':'<!doctype html><script type="module" src="/src.js"></script>',
          '/project/src.js':'document.body.textContent="ready"',
        },{workspaceRoot:'/project',startCommand:'pnpm run dev',installDependencies:false})
        const [previewPort]=await client.ports()
        const previewURL=`http://127.0.0.1:${previewPort}`
        const initialPreview=await(await client.fetch(new Request(previewURL+'/src.js'))).text()
        const session=await client.openTerminalSession()
        try{
          const before=await session.runCommand('value=preserved; printf "%s\\n" "$value"').result
          await client.writeFile('/project/package.json',manifest)
          await client.writeFile('/project/package-lock.json',lock)
          const output=[]
          const install=await session.runCommand('pnpm install',text=>output.push(text)).result
          await client.writeFile('/project/src.js','import isNumber from "is-number"; document.body.textContent=String(isNumber(42))')
          const updatedPreview=await(await client.fetch(new Request(previewURL+'/src.js'))).text()
          const after=await session.runCommand('printf "%s\\n" "$value"; ls node_modules/is-number').result
          return {before,install,after,output,initialPreview,updatedPreview,
            installed:!!(await client.readFile('/project/node_modules/is-number/package.json'))}
        }finally{await session.dispose()}
      }catch(error){return {error:String(error),stack:error?.stack}}
      finally{await client.dispose();client.close();frame.remove()}
    },{owner,manifest,lock})
    console.log(name,JSON.stringify({...result,initialPreview:result.initialPreview?.slice(0,100),updatedPreview:result.updatedPreview?.slice(0,200)}))
    if(result.error)throw Error(result.stack??result.error)
    assert.equal(result.before.stdout,'preserved\n')
    assert.equal(result.install.exitCode,0)
    assert.equal(result.after.exitCode,0)
    assert.match(result.after.stdout,/preserved/)
    assert.equal(result.installed,true)
    assert.match(result.updatedPreview,/is-number/)
  }finally{await browser.close()}
}
