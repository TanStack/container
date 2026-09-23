import {test,expect} from '@playwright/test'

for(const id of ['esbuild-wasm-guest','rollup-browser-guest','sqlite','astro'])test('WASM candidate package probe: '+id,async({page},info)=>{
  const errors:string[]=[]
  page.on('pageerror',error=>errors.push(String(error)))
  page.on('crash',()=>errors.push('Page crashed'))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(id=>window.sandboxLab.runWorkload(id,undefined,{guestWasm:true}),id)
  await info.attach('candidate-workload.json',{body:JSON.stringify(result),contentType:'application/json'})
  console.log(info.project.name,id,result.status,result.error?.slice(0,350)??'')
  expect(errors).toEqual([])
  expect(result.status).not.toBe('fixture-error')
  if(result.status==='pass'||result.status==='adapted-pass')expect(result.iterations).toHaveLength(4)
  // A completed experiment is not a compatibility pass. The attached result
  // records the exact first blocker, including when it predates WASM loading.
  await expect(page.locator('h1')).toHaveText('Sandbox feasibility lab')
})
