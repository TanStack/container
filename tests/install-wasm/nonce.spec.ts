import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
const source=`import {atob as decode,btoa as encode} from 'node:buffer';import {webcrypto} from 'node:crypto';
const result=[atob===decode,btoa===encode,crypto===webcrypto];
for(const fn of [atob,btoa])for(const args of [[],[''],['hello'],['YQ=='],['Y Q\\n=='],['YQ'],['Y'],['a==='],['\\u0100'],['\\u00ff'],[null],[undefined],[Symbol('x')]]){
try{result.push(fn(...args))}catch(e){result.push([e.name,e.code??null])}}
const bytes=new Uint8Array(16);result.push(crypto.getRandomValues(bytes)===bytes);const nonce=btoa(String.fromCharCode(...bytes));result.push(nonce.length,atob(nonce).length);console.log(JSON.stringify(result));`
test('Node globals support CSP nonces and validated base64',async({page})=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async source=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/probe.mjs':source})
    try{return await kernel.runModule('/probe.mjs',{guestWasm:true,webAPIs:true})}finally{kernel.close()}
  },source)
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(JSON.parse(node.stdout))
})
