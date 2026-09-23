import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/'+name,readFileSync('fixtures/install-start-portable/'+name,'utf8')]))
for(const phase of ['rollup','load','boot'])test(`explicit Rollup WASM override: ${phase==='rollup'?'bundle and execute JavaScript':phase==='boot'?'boot Vite and transform TypeScript':'load installed Vite'}`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({files,phase})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{workspace:{maxBytes:128*1024*1024}})
    let stage='install'
    try{
      const installation=await kernel.install({ignoreScripts:true})
      stage=phase==='rollup'?'bundle-rollup':phase==='boot'?'boot-vite':'load-vite'
      await kernel.writeText('/index.html','<html><body><div id="app"></div><script type="module" src="/main.ts"></script></body></html>')
      await kernel.writeText('/main.ts','const value: number = 42; document.querySelector("#app").textContent = String(value);')
      await kernel.writeText('/bundle.js','import {value} from "./value.js"; export const answer=value+2;')
      await kernel.writeText('/value.js','export const value=40;')
      await kernel.writeText('/probe.mjs',phase==='rollup'?`
        import {rollup} from 'rollup';import fs from 'node:fs';
        const bundle=await rollup({input:'/bundle.js'});
        try{const generated=await bundle.generate({format:'iife',name:'Bundle'});console.log(eval(generated.output[0].code+'\\nBundle.answer'))}finally{await bundle.close()}
        fs.writeFileSync('/value.js','export const value=41;');
        const edited=await rollup({input:'/bundle.js',cache:bundle.cache});
        try{const generated=await edited.generate({format:'iife',name:'Edited'});console.log(eval(generated.output[0].code+'\\nEdited.answer'))}finally{await edited.close()}
      `:phase==='boot'?`
        import {createServer} from 'vite';import http from 'node:http';
        const server=await createServer({root:'/',configFile:false,server:{host:'127.0.0.1',port:8512,strictPort:true}});
        try{
          await server.listen();
          const get=path=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:8512,path},res=>{let text='';res.on('data',bytes=>text+=bytes);res.on('end',()=>resolve({status:res.statusCode,text}));res.on('error',reject)}).on('error',reject));
          const index=await get('/'),module=await get('/main.ts');console.log(JSON.stringify({index,module}));
        }finally{await server.close()}
      `:'import {version} from "vite";console.log(version)')
      const execution=await kernel.runModule('/probe.mjs',{guestWasm:true,webAPIs:true,maxBytes:64*1024*1024,timeoutMs:30000})
      return {stage,installation,execution}
    }catch(error){return {stage,error:String(error)}}finally{kernel.close()}
  },{files,phase})
  await info.attach('portable-start.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.error,JSON.stringify(result)).toBeUndefined()
  expect(result.installation?.packageAliases).toContainEqual({installPath:'/node_modules/rollup',name:'@rollup/wasm-node',version:'4.63.1'})
  expect(result.execution?.exitCode,result.execution?.stderr).toBe(0)
  if(phase==='rollup')expect(result.execution?.stdout).toBe('42\n43\n')
  else if(phase==='load')expect(result.execution?.stdout).toBe('7.3.6\n')
  else{
    const output=JSON.parse(result.execution!.stdout.trim().split('\n').at(-1)!)
    expect(output.index.status).toBe(200);expect(output.index.text).toContain('/@vite/client')
    expect(output.module.status).toBe(200);expect(output.module.text).toContain('42');expect(output.module.text).not.toContain(': number')
  }
})
