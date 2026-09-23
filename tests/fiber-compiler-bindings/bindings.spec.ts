import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
// @ts-expect-error The shared Node fixture collector is plain JavaScript without declarations.
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const bindings=[
  {name:'@rolldown/binding-wasm32-wasi',root:'fixtures/compiler-wasi'},
  {name:'@astrojs/compiler-binding-wasm32-wasi',root:'fixtures/compiler-wasi-astro'},
  ...['@emnapi/wasi-threads','@emnapi/core','@emnapi/runtime','@napi-rs/wasm-runtime'].map(name=>({name,root:'fixtures/compiler-wasi'})),
]

for(const binding of bindings)test(`real compiler binding loads: ${binding.name}`,async({page},info)=>{
  const directory=resolve(binding.root)
  const manifest=JSON.parse(readFileSync(resolve(directory,'node_modules',binding.name,'package.json'),'utf8'))
  const snapshot=await collectInstalledClosure(directory,[binding.name])
  await page.route('**/__compiler-binding-fixture.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(snapshot)}))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async name=>{
    const snapshot=await fetch('/__compiler-binding-fixture.json').then(response=>response.json())
    const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value]:[string,any])=>[
      '/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0)),
    ]))
    files['/project/main.cjs']=new TextEncoder().encode(`const binding=require(${JSON.stringify(name)});console.log(JSON.stringify({exports:Object.keys(binding).sort()}))`)
    const kernel=new window.sandboxLab.WorkerKernel(files,{
      experimentalFibers:true,cooperative:false,maxBytes:256*1024*1024,timeoutMs:15000,
      workspace:{maxBytes:64*1024*1024},
    })
    try{return await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,timeoutMs:15000,maxBytes:256*1024*1024})}
    finally{kernel.close()}
  },binding.name)
  const path=info.outputPath('compiler-binding-result.json')
  await writeFile(path,JSON.stringify({name:binding.name,version:manifest.version,engine:'experimentalFibers',scope:'Actual installed binding load and exports, not a compilation workload',result},null,2))
  await info.attach('compiler-binding-result.json',{path,contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).exports.length).toBeGreaterThan(0)
})
