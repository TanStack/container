import {test,expect,type Page} from '@playwright/test'

async function run(page:Page,cases:number[][]){
  await page.goto('/sandbox.html')
  return page.evaluate(async cases=>{
    const path='/tls-probe/tls.mjs'
    const create=(await import(/* @vite-ignore */path)).default
    const lines:string[]=[]
    const module=await create({print:(line:string)=>lines.push(line)})
    return cases.map(args=>{
      const code=module._tls_probe(...args)
      if(code!==0)throw Error(`TLS probe failed with ${code}: ${lines.at(-1)}`)
      return JSON.parse(lines.pop()!)
    })
  },cases)
}

for(const version of [12,13])for(const fragment of [1,13,16384])test(`TLS ${version}: records fragmented at ${fragment} bytes`,async({page},info)=>{
  // Every rejected peer is followed by a successful fresh connection in the
  // same WASM instance. No ignore-certificate-error mode exists in this probe.
  const cases=Array.from({length:6},(_,mode)=>[[mode,fragment,version,2097152,0],[0,fragment,version,2097152,0]]).flat()
  const results=await run(page,cases)
  await info.attach('tls-results.json',{body:JSON.stringify(results),contentType:'application/json'})
  for(const result of results){
    expect(result.liveBytes).toBe(0)
    expect(result.expected,JSON.stringify(result)).toBe(1)
    expect(result.accepted).toBe(result.mode===0?1:0)
    if(result.mode===0){
      expect(result.protocol).toBe(version===12?'TLSv1.2':'TLSv1.3')
      expect(result.verifyFlags).toBe(0)
      expect(result.closed).toBe(1)
      expect(result.wireBytes).toBeGreaterThan(100)
    }
  }
})

for(const version of [12,13])test(`TLS ${version}: memory pressure and sampled allocation failures recover`,async({page},info)=>{
  const budgets=[0,131072,163840,196608,229376,262144,524288]
  const sites=[1,2,3,4,8,16,32,64,128,256,512,1024,2048,4096,8192,12000]
  const attempts=[...budgets.map(budget=>[0,13,version,budget,0]),...sites.map(site=>[0,13,version,2097152,site])]
  const cases=attempts.flatMap(args=>[args,[0,13,version,2097152,0]])
  const results=await run(page,cases)
  await info.attach('tls-allocation.json',{body:JSON.stringify(results),contentType:'application/json'})
  let failures=0,successes=0
  for(let i=0;i<results.length;i+=2){
    const result=results[i],recovery=results[i+1]
    expect(result.liveBytes).toBe(0)
    expect(result.peakBytes).toBeLessThanOrEqual(result.budget)
    if(result.accepted)successes++;else failures++
    expect(recovery.accepted,JSON.stringify({result,recovery})).toBe(1)
    expect(recovery.liveBytes).toBe(0)
  }
  expect(failures).toBeGreaterThan(0)
  expect(successes).toBeGreaterThan(0)
})
