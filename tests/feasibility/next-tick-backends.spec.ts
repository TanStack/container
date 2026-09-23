import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
import {writeFile} from 'node:fs/promises'

const cases=[
  {name:'timer cancellation across a bounded microtask checkpoint',source:`import process from 'node:process';const rows=[];const cancelled=setTimeout(()=>rows.push('cancelled'),0);let chain=Promise.resolve();for(let i=0;i<240;i++)chain=chain.then(()=>{if(i===200)clearTimeout(cancelled);if(i===239)rows.push('microtasks')});await new Promise(resolve=>setTimeout(resolve,0));console.log(JSON.stringify(rows));`},
  {name:'startup ESM',source:`import process from 'node:process';const rows=[];process.nextTick(()=>rows.push('tick'));let chain=Promise.resolve();for(let i=0;i<240;i++)chain=chain.then(()=>{if(i===239)rows.push('microtasks')});await new Promise(resolve=>setTimeout(resolve,0));console.log(JSON.stringify(rows));`},
  {name:'timer finite microtasks and ALS',source:`import process from 'node:process';import {AsyncLocalStorage} from 'node:async_hooks';const store=new AsyncLocalStorage(),rows=[];await new Promise(resolve=>store.run('timer-context',()=>setTimeout(()=>{process.nextTick(()=>rows.push(['tick',store.getStore()]));let chain=Promise.resolve();for(let i=0;i<240;i++)chain=chain.then(()=>{if(i===239)rows.push(['microtasks',store.getStore()])});chain.then(()=>setTimeout(resolve,0))},0)));console.log(JSON.stringify(rows));`},
]

for(const engine of ['quickjs-als','quickjs-als-asyncify'] as const)for(const fixture of cases){
  test(`${engine} nextTick ${fixture.name}`,async({page},info)=>{
    const native=spawnSync(process.execPath,['--input-type=module','-e',fixture.source],{encoding:'utf8',timeout:10000})
    expect(native.status,native.stderr).toBe(0)
    const expected=JSON.parse(native.stdout.trim())
    await page.goto('/sandbox.html')
    await page.waitForFunction(()=>!!window.sandboxLab)
    const observed=await page.evaluate(async({engine,source})=>{
      const workspace=new window.sandboxLab.Workspace({files:{'/main.mjs':source}})
      try{return await workspace.executeInVM('/main.mjs',{engine,timeoutMs:10000,maxBytes:32*1024*1024})}finally{workspace.close()}
    },{engine,source:fixture.source})
    const path=info.outputPath('next-tick-backend.json')
    await writeFile(path,JSON.stringify({engine,fixture:fixture.name,expected,observed},null,2))
    await info.attach('next-tick-backend.json',{path,contentType:'application/json'})
    expect(observed.exitCode,observed.stderr).toBe(0)
    expect(JSON.parse(observed.stdout.trim())).toEqual(expected)
  })
}
