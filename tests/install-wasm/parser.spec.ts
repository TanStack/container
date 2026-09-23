import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const parser=require('@babel/parser')
const parserSource=readFileSync(require.resolve('@babel/parser'),'utf8')
const cases={route:['const x=1','const x={...a};','const x=<div/>;',readFileSync('fixtures/start-basic/src/routes/index.tsx','utf8')],
  'server-function dependency':[readFileSync('node_modules/@tanstack/start-client-core/dist/esm/createServerFn.js','utf8')]}
for(const [name,samples] of Object.entries(cases)){
const reference=samples.map(source=>parser.parse(source,{sourceType:'module',plugins:['typescript','jsx']}).program.body.length)
for(const guestWasm of [false,true])test(`isolated Babel ${name} parser (${guestWasm?'WASM bridge':'default'})`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({parserSource,samples,guestWasm})=>{
    const source=`import parser from '/parser.cjs';const results=[];for(const source of ${JSON.stringify(samples)}){try{results.push(parser.parse(source,{sourceType:'module',plugins:['typescript','jsx']}).program.body.length)}catch(error){results.push({name:error.name,message:error.message,stack:error.stack})}}console.log(JSON.stringify(results));`
    const kernel=new window.sandboxLab.WorkerKernel({'/parser.cjs':parserSource,'/probe.mjs':source})
    try{return await kernel.runModule('/probe.mjs',{guestWasm,timeoutMs:15000})}finally{kernel.close()}
  },{parserSource,samples,guestWasm})
  await info.attach('parser.json',{body:JSON.stringify({reference,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(reference)
})
}
