import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/'+name,readFileSync('fixtures/install-start-wasm/'+name,'utf8')]))
const cooperative=process.env.PREBUNDLE_SYNC!=='1'
const expanded=process.env.PREBUNDLE_EXPANDED==='1'
const profileJobs=process.env.PREBUNDLE_PROFILE_JOBS!=='0'
const sourcemap=process.env.PREBUNDLE_SOURCEMAP!=='0'
const writeOutput=process.env.PREBUNDLE_WRITE==='1'
const sourcesContent=process.env.PREBUNDLE_SOURCES_CONTENT!=='0'
const subset=process.env.PREBUNDLE_SUBSET
if(subset&&!['react','react-dom','router'].includes(subset))throw Error('Unsupported prebundle subset')
const entries=subset==='react'?['react']:subset==='react-dom'?['react-dom/client']:subset==='router'?['@tanstack/router-core']:['react','react-dom','react/jsx-dev-runtime','react/jsx-runtime','react-dom/client','@tanstack/react-store',...(expanded?['@tanstack/router-core/isServer','@tanstack/router-core/ssr/client','@tanstack/router-core','seroval']:[])]
for(const concurrent of [false,true])test('React dependency prebundle'+(subset?' subset '+subset:expanded?' with discovered Start dependencies':'')+(concurrent?' with concurrent transform':''),async({page,context},info)=>{
  const explicitCandidate=process.env.TERMINATION_COOPERATIVE==='1'||!!process.env.WASM_TEST_OPT
  if(explicitCandidate){
    for(const wasm of ['', '-wasm']){
      const name=cooperative?'quickjs-als-asyncify'+wasm+'-o2-generator-queue-yield-profile'+(wasm?'-poll4096':'')+'-cooperative'+(wasm&&process.env.COOPERATIVE_WASM_BATCH?'-batch'+process.env.COOPERATIVE_WASM_BATCH:'')+(wasm&&process.env.COOPERATIVE_ASSIGNMENTS==='1'?'-assignments':''):'quickjs-als'+wasm+'-'+(wasm?process.env.WASM_TEST_OPT:'o2')
      await info.attach('engine'+wasm+'.json',{body:readFileSync('public/'+name+'/build.json'),contentType:'application/json'})
    }
  }
  for(const wasm of cooperative&&!explicitCandidate?['', '-wasm']:[]){
    const base='quickjs-als-asyncify'+wasm
    const suffix=(wasm&&process.env.PREBUNDLE_OPT==='O2'?'-o2':'')+'-generator-queue'+(wasm&&process.env.PREBUNDLE_YIELD_PROFILE==='1'?'-yield-profile':'')+(wasm&&process.env.PREBUNDLE_WASM_POLL==='4096'?'-poll4096':'')
    await context.route('**/'+base+'-cooperative/**',route=>route.continue({url:route.request().url().replace(base+'-cooperative/',base+suffix+'-cooperative/')}))
    await info.attach('engine'+wasm+'.json',{body:readFileSync('public/'+base+suffix+'-cooperative/build.json'),contentType:'application/json'})
  }
  if(!cooperative&&!explicitCandidate)await info.attach('engine-wasm.json',{body:readFileSync('public/quickjs-als-wasm/build.json'),contentType:'application/json'})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({files,concurrent,cooperative,entries,profileJobs,sourcemap,writeOutput,sourcesContent})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{cooperative,maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
    try{
      await kernel.install({ignoreScripts:true})
      await kernel.writeText('/probe.mjs',`
        import {context,transform,stop} from 'esbuild';
        import {statSync} from 'node:fs';
        const started=performance.now();
        console.log(JSON.stringify({phase:'imported',ms:0}));
        const ctx=await context({entryPoints:${JSON.stringify(entries)},bundle:true,splitting:true,format:'esm',platform:'browser',target:['chrome107','edge107','firefox104','safari16'],jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},sourcemap:${sourcemap},sourcesContent:${sourcesContent},metafile:true,write:${writeOutput},outdir:'/out',ignoreAnnotations:true});
        try{
          console.log(JSON.stringify({phase:'context-ready',ms:performance.now()-started}));
          const build=ctx.rebuild().then(result=>{
            const ms=performance.now()-started;
            const outputs=${writeOutput}?Object.entries(result.metafile.outputs).map(([path,output])=>{const size=statSync(path.startsWith('/')?path:'/'+path).size;if(size!==output.bytes)throw Error('Output size mismatch: '+path);return size}):result.outputFiles.map(file=>file.contents.length);
            console.log(JSON.stringify({phase:'build',ms,files:outputs.length,bytes:outputs.reduce((n,size)=>n+size,0),inputs:Object.keys(result.metafile.inputs).length}));return result});
          ${concurrent?`const transformed=transform('export const value: number = 42',{loader:'ts'}).then(result=>{if(!result.code.includes('42'))throw Error('Incorrect transform');console.log(JSON.stringify({phase:'transform',ms:performance.now()-started}))});await Promise.all([build,transformed]);`:'await build;'}
          console.log('PREBUNDLE_COMPLETE');
        }finally{await ctx.dispose();stop()}
      `)
      const execution=await kernel.runModule('/probe.mjs',{guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:30000,profileJobs})
      return {execution,profile:kernel.jobProfile}
    }finally{kernel.close()}
  },{files,concurrent,cooperative,entries,profileJobs,sourcemap,writeOutput,sourcesContent})
  await info.attach('react-prebundle.json',{body:JSON.stringify({entries,sourcemap,writeOutput,sourcesContent,...result}),contentType:'application/json'})
  console.log(JSON.stringify({cooperative,concurrent,expanded,entries,sourcemap,writeOutput,sourcesContent,profileJobs,execution:result.execution,slowest:result.profile.slice(0,3)}))
  expect(result.execution.exitCode,result.execution.stderr).toBe(0)
  expect(result.execution.stdout).toContain('PREBUNDLE_COMPLETE')
})
