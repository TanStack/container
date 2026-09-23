import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
// @ts-expect-error Shared JavaScript fixture generator.
import {rollupScaleSource} from '../../fixtures/compiler-scale.mjs'

const profiles=[
  ...[100,1000,5000].map(count=>({profile:'baseline',count,maxBytes:64*1024*1024,timeoutMs:10000})),
  {profile:'desktop',count:1000,maxBytes:128*1024*1024,timeoutMs:30000},
  {profile:'desktop',count:5000,maxBytes:256*1024*1024,timeoutMs:90000},
]
for(const settings of profiles){
const {count,profile}=settings
test(`${profile==='desktop'?'Desktop budget | ':''}Rollup ${count} modules build, edit, cache and recover`,async({page},info)=>{
  const files:Record<string,string|number[]>={
    '/package.json':'{"type":"module"}',
    '/rollup.js':readFileSync('fixtures/workloads/node_modules/@rollup/browser/dist/es/rollup.browser.js','utf8'),
    '/bindings_wasm_bg.wasm':[...readFileSync('fixtures/workloads/node_modules/@rollup/browser/dist/es/bindings_wasm_bg.wasm')],
    '/main.mjs':rollupScaleSource(count),
  }
  await page.goto('/sandbox.html')
  const evidence=await page.evaluate(async({files,settings})=>{
    const {maxBytes,timeoutMs}=settings
    const kernel=new window.sandboxLab.WorkerKernel(Object.fromEntries(Object.entries(files).map(([path,data])=>[path,Array.isArray(data)?new Uint8Array(data):data])),settings.profile==='desktop'?{maxBytes,timeoutMs}:undefined)
    let ticks=0,maxIntervalMs=0,previous=performance.now();
    const timer=setInterval(()=>{const now=performance.now();maxIntervalMs=Math.max(maxIntervalMs,now-previous);previous=now;ticks++},16)
    try{
      const result=await kernel.runModule('/main.mjs',{webAPIs:true,workspaceFetch:true,guestWasm:true,diagnostics:true,maxBytes,timeoutMs})
      return {result,ui:{ticks,maxIntervalMs},guestLimitBytes:maxBytes,timeoutMs}
    }finally{clearInterval(timer);kernel.close()}
  },{files,settings})
  const lines=evidence.result.stdout.trim().split('\n');
  const details=evidence.result.exitCode===0?JSON.parse(lines.at(-1)!):undefined
  await info.attach('compiler-scale.json',{body:JSON.stringify({profile,count,...evidence,details}),contentType:'application/json'})
  expect(evidence.result.exitCode,evidence.result.stderr).toBe(0)
  const sum=count*(count-1)/2
  expect(details.rows.map((row:{answer:number})=>row.answer)).toEqual([sum,sum+1,sum+1,sum,sum])
  expect(details.rows.every((row:{modules:number})=>row.modules===count+1)).toBe(true)
  expect(details.errorCode).toBe('PARSE_ERROR')
  expect(details.closed).toBe(6)
})
}
