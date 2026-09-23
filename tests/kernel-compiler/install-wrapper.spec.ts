import {test,expect} from '@playwright/test'
import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {arch,release} from 'node:os'

const names=['package.json','bin/esbuild','lib/main.js','wasm_exec.js','wasm_exec_node.js','esbuild.wasm']
const assets=new Map(names.map(name=>[name,readFileSync('node_modules/esbuild-wasm/'+name)]))
const hashes=Object.fromEntries([...assets].map(([name,bytes])=>[name,createHash('sha256').update(bytes).digest('hex')]))

test.beforeEach(async({page})=>{
  await page.route('**/__compiler_fixture/**',route=>{
    const name=decodeURIComponent(new URL(route.request().url()).pathname.split('/__compiler_fixture/')[1])
    const body=assets.get(name)
    return body?route.fulfill({body,contentType:'application/octet-stream'}):route.abort()
  })
  await page.goto('/sandbox.html')
})

test('published esbuild wrapper builds with guest plugins through opt-in compiler worker',async({page,browser},info)=>{
  const result=await page.evaluate(async names=>{
    const files=Object.fromEntries(await Promise.all(names.map(async name=>['/node_modules/esbuild-wasm/'+name,new Uint8Array(await(await fetch('/__compiler_fixture/'+encodeURIComponent(name))).arrayBuffer())])))
    const kernel=new window.sandboxLab.WorkerKernel(files,{maxBytes:128*1024*1024,workspace:{maxBytes:64*1024*1024},experimentalCompiler:{maxMemoryPages:1024,timeoutMs:15000}} as any)
    try{
      const cli=await kernel.spawn('node',['/node_modules/esbuild-wasm/bin/esbuild','--version'],{timeoutMs:30000,maxBytes:128*1024*1024})
      let version
      try{version=await cli.wait()}finally{await cli.dispose()}
      await kernel.writeText('/entry.ts','import {answer} from "./answer"; import {label} from "virtual:label"; console.log(label,answer)')
      await kernel.writeText('/answer.ts','export const answer:number=42')
      await kernel.writeText('/main.mjs',`
        import {build,transform,stop} from 'esbuild-wasm';
        import {readFileSync,writeFileSync} from 'node:fs';
        import assert from 'node:assert/strict';
        let label='first';const callbacks=[];
        const options={absWorkingDir:'/',entryPoints:['entry.ts'],bundle:true,write:true,outfile:'/out/bundle.js',format:'esm',plugins:[{name:'guest-plugin',setup(api){
          api.onResolve({filter:/^virtual:/},args=>{callbacks.push('resolve');return {path:args.path,namespace:'guest'}});
          api.onLoad({filter:/.*/,namespace:'guest'},async()=>{await Promise.resolve();callbacks.push('load');return {contents:'export const label='+JSON.stringify(label),loader:'js'}});
        }}]};
        try{
          await build(options);assert.match(readFileSync('/out/bundle.js','utf8'),/answer = 42/);
          label='second';writeFileSync('/answer.ts','export const answer:number=43');
          await build(options);const output=readFileSync('/out/bundle.js','utf8');assert.match(output,/answer = 43/);assert.match(output,/second/);
          const transformed=await transform('export const n:number=7',{loader:'ts'});assert.ok(!transformed.code.includes(':number'));
          assert.deepEqual(callbacks,['resolve','load','resolve','load']);
          console.log(JSON.stringify({callbacks,output,transformed:transformed.code}));
        }finally{stop()}
      `)
      const execution=await kernel.runModule('/main.mjs',{guestWasm:false,webAPIs:true,writable:true,maxBytes:128*1024*1024,timeoutMs:30000})
      return {version,execution,resources:await kernel.resources()}
    }finally{kernel.close()}
  },names)
  const evidence=info.outputPath('installed-wrapper.json')
  writeFileSync(evidence,JSON.stringify({browser:info.project.name,browserVersion:browser.version(),os:release(),arch:arch(),hashes,...result},null,2))
  await info.attach('installed-wrapper.json',{path:evidence,contentType:'application/json'})
  expect(result.execution.exitCode,result.execution.stderr).toBe(0)
  expect(result.version.exitCode,result.version.stderr).toBe(0)
  expect(result.version.stdout.trim()).toBe('0.28.2')
  expect(JSON.parse(result.execution.stdout.trim()).callbacks).toEqual(['resolve','load','resolve','load'])
  expect(result.resources.processes.active).toBe(0)
  expect(result.resources.fileSessions).toBe(0)
})

for(const slow of [false,true])test(slow?'session bounds a slow plugin request and cleans up':'session survives idle time and rebuilds through published context API',async({page,browser},info)=>{
  const result=await page.evaluate(async({names,slow})=>{
    const files=Object.fromEntries(await Promise.all(names.map(async name=>['/node_modules/esbuild-wasm/'+name,new Uint8Array(await(await fetch('/__compiler_fixture/'+encodeURIComponent(name))).arrayBuffer())])))
    const kernel=new window.sandboxLab.WorkerKernel(files,{maxBytes:128*1024*1024,workspace:{maxBytes:64*1024*1024},experimentalCompiler:{maxMemoryPages:1024,timeoutMs:2000,lifetime:'session'}} as any)
    try{
      await kernel.writeText('/main.mjs',`
        import {context,transform,stop} from 'esbuild-wasm';
        import assert from 'node:assert/strict';
        let revision=42,ctx;
        try{
          ctx=await context({entryPoints:['virtual-entry'],bundle:true,write:false,format:'esm',plugins:[{name:'ordinary-plugin',setup(api){
            api.onResolve({filter:/.*/},args=>({path:args.path,namespace:'virtual'}));
            api.onLoad({filter:/.*/,namespace:'virtual'},async()=>{${slow?'await new Promise(resolve=>setTimeout(resolve,3000));':''}return {contents:'export const answer:number='+revision,loader:'ts'}});
          }}]});
          const first=await ctx.rebuild();assert.ok(first.outputFiles[0].text.includes('42'));
          await new Promise(resolve=>setTimeout(resolve,2250));
          revision=43;const second=await ctx.rebuild();assert.ok(second.outputFiles[0].text.includes('43'));
          const transforms=await Promise.all([1,2,3].map(n=>transform('export const n:number='+n,{loader:'ts'})));
          assert.equal(transforms.length,3);console.log('session rebuilt after idle');
        }finally{if(ctx)await ctx.dispose();stop()}
      `)
      const process=await kernel.spawn('node',['/main.mjs'],{guestWasm:false,webAPIs:true,writable:true,maxBytes:128*1024*1024,timeoutMs:30000,lifetime:'session'})
      let execution
      try{execution=await process.wait()}finally{await process.dispose()}
      return {execution,resources:await kernel.resources()}
    }finally{kernel.close()}
  },{names,slow})
  const path=info.outputPath('session.json')
  writeFileSync(path,JSON.stringify({browser:info.project.name,browserVersion:browser.version(),slow,hashes,...result},null,2))
  await info.attach('session.json',{path,contentType:'application/json'})
  if(slow){expect(result.execution.exitCode).not.toBe(0);expect(result.execution.stderr).toMatch(/deadline|timed out/i)}
  else{expect(result.execution.exitCode,result.execution.stderr).toBe(0);expect(result.execution.stdout).toContain('session rebuilt after idle')}
  expect(result.resources.processes.active).toBe(0)
  expect(result.resources.fileSessions).toBe(0)
})
