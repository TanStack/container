import type {Frame,Page} from '@playwright/test'

export async function captureHMR(target:Frame|Page,events:unknown[]){
  const page='page' in target?target.page():target
  await page.exposeFunction('recordRecoveryHMR',(event:unknown)=>events.push(event))
  page.on('framenavigated',frame=>events.push({name:'navigation',url:frame.url(),at:Date.now()}))
  await attachHMR(target)
}

export async function attachHMR(target:Frame|Page){
  await target.evaluate(async()=>{
    const url='/@vite/client'
    const {createHotContext}=await import(/* @vite-ignore */url)
    const hot=createHotContext('/__recovery_probe')
    await (window as any).recordRecoveryHMR({name:'collector-attached',at:Date.now(),url:location.href})
    for(const name of ['vite:beforeUpdate','vite:afterUpdate','vite:beforeFullReload','vite:error','vite:invalidate']){
      hot.on(name,(payload:unknown)=>(window as any).recordRecoveryHMR({name,at:Date.now(),payload}))
    }
  })
}
