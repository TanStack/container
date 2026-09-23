import {test,expect} from '@playwright/test'
import {mkdtempSync,cpSync,symlinkSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {transformProfiler} from '../fixtures/vite-transform-profiler.mjs'

test('native SvelteKit cold SSR transform graph',async({request},info)=>{
  const fixture=resolve('fixtures/install-sveltekit-wasm'),root=mkdtempSync(join(tmpdir(),'svelte-native-ssr-'))
  for(const file of ['package.json','vite.config.js','svelte.config.js','src'])cpSync(join(fixture,file),join(root,file),{recursive:true})
  symlinkSync(join(fixture,'node_modules'),join(root,'node_modules'),'dir')
  const {createServer}=await import(join(fixture,'node_modules/vite/dist/node/index.js'))
  const previousCwd=process.cwd(),profile=join(root,'transforms.json')
  let server:any
  try{
    process.chdir(root)
    server=await createServer({root,plugins:[transformProfiler(profile)],server:{host:'127.0.0.1',port:0}})
    await server.listen()
    const started=performance.now()
    const response=await request.get(server.resolvedUrls.local[0])
    const html=await response.text(),ms=performance.now()-started
    await info.attach('native-cold-ssr.json',{body:JSON.stringify({root,status:response.status(),ms}),contentType:'application/json'})
    await info.attach('native-transform-profile.json',{body:readFileSync(profile),contentType:'application/json'})
    expect(response.status()).toBe(200)
    expect(html).toContain('Installed SvelteKit')
    expect(html).toContain('SvelteKit server loader ran')
  }finally{
    try{await server?.close()}finally{process.chdir(previousCwd)}
  }
})
