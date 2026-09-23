import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

const files=Object.fromEntries(['package.json','package-lock.json','vite.config.js','svelte.config.js','src/app.html','src/routes/+page.server.js','src/routes/+page.svelte','src/routes/api/+server.js'].map(name=>['/project/'+name,readFileSync('fixtures/install-sveltekit-wasm/'+name,'utf8')]))
const ssrOnly=process.env.SVELTE_SSR_ONLY==='1'
const noOptimizer=process.env.SVELTE_NO_OPTIMIZER==='1'
const traceTransforms=process.env.SVELTE_TRACE_TRANSFORMS==='1'
if(traceTransforms)files['/project/transform-profiler.mjs']=readFileSync('tests/fixtures/vite-transform-profiler.mjs','utf8')
if(noOptimizer&&!ssrOnly)throw Error('Optimizer-disabled diagnostics require SVELTE_SSR_ONLY=1')

test(ssrOnly?'installed SvelteKit cold SSR without a browser client'+(noOptimizer?', optimizer disabled':''):'installed SvelteKit serves SSR, hydration, server requests and edits',async({page},info)=>{
  const diagnostics:string[]=[]
  if(process.env.TERMINATION_COOPERATIVE==='1'){
    const name='quickjs-als-asyncify-wasm-'+(process.env.COOPERATIVE_WASM_OPT??'o2')+'-generator-queue-yield-profile-poll4096-cooperative'+(process.env.COOPERATIVE_WASM_BATCH?'-batch'+process.env.COOPERATIVE_WASM_BATCH:'')+(process.env.COOPERATIVE_ASSIGNMENTS==='1'?'-assignments':'')+(process.env.COOPERATIVE_UNWIND==='1'?'-unwind':'')+(process.env.COOPERATIVE_HEAP_LOOPS==='1'?'-heap-loops':'')
    const bytes=readFileSync('public/'+name+'/engine.wasm')
    const metadata=JSON.parse(readFileSync('public/'+name+'/build.json','utf8'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(metadata.wasmSha256)
    await info.attach('svelte-engine.json',{body:JSON.stringify(metadata),contentType:'application/json'})
  }
  page.on('pageerror',error=>diagnostics.push(error.message))
  await page.goto('/sandbox.html')
  try{
    await page.evaluate(async({files,captureCompiler,profileJobs,ssrOnly,noOptimizer,traceTransforms})=>{
      const {WorkerKernel,WorkerHTTP,WorkerWebSocket,URLPreview}=window.sandboxLab
      const kernel=new WorkerKernel(files,{cooperative:true,maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
      const logs:string[]=[]
      Object.assign(window,{svelteKernel:kernel,svelteLogs:logs})
      await kernel.install({cwd:'/project',ignoreScripts:true})
      if(captureCompiler){
        const path='/project/node_modules/esbuild/lib/main.js'
        const original=await kernel.readText(path),marker='let sendRequest = (refs, value, callback) => {'
        if(original.split(marker).length!==2)throw Error('Unexpected esbuild trace site')
        await kernel.writeText(path,original.replace(marker,`let probeIndex=0;${marker}
          const index=probeIndex++;const event={index,command:value.command,flags:value.flags,entries:value.entries,start:performance.now()};
          const save=()=>require('node:fs').writeFileSync('/project/esbuild-probe-'+index+'.json',JSON.stringify(event));save();
          const originalCallback=callback;callback=(...args)=>{event.end=performance.now();event.error=args[0]?String(args[0]):undefined;save();return originalCallback(...args)};
          if(value.input)require('node:fs').writeFileSync('/project/esbuild-input-'+index+'.txt',value.input);
        `))
        const parser='/project/node_modules/rollup/dist/native.js'
        await kernel.writeText(parser,(await kernel.readText(parser))+`\nlet parseIndex=0;for(const key of ['parse','parseAsync']){const original=exports[key];exports[key]=function(...args){const index=parseIndex++,fs=require('node:fs'),path='/project/esbuild-probe-rollup-'+index+'.json';const event={index,key,start:performance.now()};fs.writeFileSync('/project/esbuild-input-rollup-'+index+'.txt',args[0]);const save=()=>fs.writeFileSync(path,JSON.stringify(event));save();try{const result=original.apply(this,args);if(result&&typeof result.then==='function')return result.then(value=>{event.end=performance.now();save();return value},error=>{event.error=String(error);save();throw error});event.end=performance.now();save();return result}catch(error){event.error=String(error);save();throw error}}}`)
      }
      const probePlugins=[]
      if(noOptimizer)probePlugins.push(`{name:'probe-disable-optimizer',enforce:'post',configResolved(config){for(const value of [config,...Object.values(config.environments)]){value.optimizeDeps.noDiscovery=true;value.optimizeDeps.include=[]}}}`)
      if(traceTransforms)probePlugins.push('transformProfiler()')
      await kernel.writeText('/project/server.mjs',`${traceTransforms?"import {transformProfiler} from './transform-profiler.mjs';":''}import {createServer} from 'vite';const server=await createServer({plugins:[${probePlugins.join(',')}],server:{host:'127.0.0.1',port:8517,strictPort:true}});await server.listen();${noOptimizer?`for(const [name,env] of Object.entries(server.environments)){if(env.depsOptimizer)throw Error('Optimizer still active: '+name)}console.log('OPTIMIZERS_DISABLED');`:''}console.log('SVELTE_READY');`)
      const server=await kernel.spawn('node',['server.mjs'],{cwd:'/project',lifetime:'session',guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:30000,profileJobs,diagnostics:profileJobs})
      let output=''
      for(;;){
        const event=await server.next()
        if(event?.type==='stdout'||event?.type==='stderr'){const text=new TextDecoder().decode(event.bytes);logs.push(text);output+=text}
        if(output.includes('SVELTE_READY'))break
        if(!event||event.type==='exit')throw Error('SvelteKit startup failed: '+output)
      }
      void(async()=>{try{for(;;){const event=await server.next();if(event?.type==='stdout'||event?.type==='stderr'){if(logs.length<300)logs.push(new TextDecoder().decode(event.bytes))}else break}}catch{}})()
      if(ssrOnly){
        const sample:{started:number;headersMs?:number;totalMs?:number;status?:number;html?:string;error?:string}={started:performance.now()}
        Object.assign(window,{svelteSSR:sample})
        try{
          const response=await new WorkerHTTP(kernel,8517).fetch(new Request('http://127.0.0.1:4200/'))
          sample.headersMs=performance.now()-sample.started;sample.status=response.status
          sample.html=await response.text();sample.totalMs=performance.now()-sample.started
        }catch(error){sample.error=String(error);sample.totalMs=performance.now()-sample.started;throw error}
        return
      }
      const preview=await URLPreview.mount(document.querySelector('#preview')!,{origin:'http://127.0.0.1:4200',server:new WorkerHTTP(kernel,8517),connectWebSocket:(url,protocols)=>WorkerWebSocket.connect(kernel,8517,'http://127.0.0.1:4200',url,protocols)})
      Object.assign(window,{sveltePreview:preview})
    },{files,captureCompiler:process.env.SVELTE_CAPTURE_COMPILER==='1',profileJobs:process.env.SVELTE_PROFILE_JOBS==='1',ssrOnly,noOptimizer,traceTransforms})
    if(ssrOnly){
      const result=await page.evaluate(()=>(window as any).svelteSSR)
      expect(result.status).toBe(200)
      expect(result.html).toContain('Installed SvelteKit')
      expect(result.html).toContain('SvelteKit server loader ran')
      return
    }
    const preview=page.frameLocator('#preview iframe')
    await expect(preview.locator('h1')).toHaveText('Installed SvelteKit',{timeout:60000})
    await expect(preview.locator('main')).toHaveAttribute('data-hydrated','true',{timeout:60000})
    await expect(preview.locator('p')).toHaveText('SvelteKit server loader ran')
    await preview.locator('#count').click()
    await expect(preview.locator('#count')).toHaveText('Count: 1')
    await preview.locator('#request').click()
    await expect(preview.locator('#reply')).toHaveText('{"method":"POST","answer":42}')
    const frame=page.frames().find(frame=>frame.url()==='http://127.0.0.1:4200/')!
    await frame.evaluate(()=>(window as any).hmrDocumentMarker='same-document')
    await page.evaluate(async()=>{
      const kernel=(window as any).svelteKernel
      const path='/project/src/routes/+page.svelte'
      await kernel.writeText(path,(await kernel.readText(path)).replace('Installed SvelteKit','Edited SvelteKit'))
    })
    await expect(preview.locator('h1')).toHaveText('Edited SvelteKit')
    // The pinned native Svelte HMR control recreates component-local state.
    await expect(preview.locator('#count')).toHaveText('Count: 0')
    expect(await frame.evaluate(()=>(window as any).hmrDocumentMarker)).toBe('same-document')
    await preview.locator('#count').click()
    await expect(preview.locator('#count')).toHaveText('Count: 1')
  }finally{
    if(traceTransforms)await info.attach('svelte-transform-profile.json',{body:await page.evaluate(()=>(window as any).svelteKernel.readText('/project/vite-transform-profile.json').catch(()=> '[]')),contentType:'application/json'})
    if(ssrOnly)await info.attach('svelte-cold-ssr.json',{body:JSON.stringify(await page.evaluate(()=>(window as any).svelteSSR??null)),contentType:'application/json'})
    await info.attach('svelte-job-profile.json',{body:JSON.stringify(await page.evaluate(()=>(window as any).svelteKernel?.jobProfile??[]).catch(()=>[])),contentType:'application/json'})
    if(process.env.SVELTE_CAPTURE_COMPILER==='1'){
      const captured=await page.evaluate(async()=>{
        const kernel=(window as any).svelteKernel;if(!kernel)return {}
        const session=await kernel.openFileSession()
        try{
          const names=await session.call('readdir',['/project']) as string[]
          const result:Record<string,string>={}
          for(const name of names.filter(name=>name.startsWith('esbuild-probe-')||name.startsWith('esbuild-input-')))result[name]=await kernel.readText('/project/'+name)
          return result
        }finally{await session.close()}
      })
      await info.attach('svelte-compiler.json',{body:JSON.stringify(captured),contentType:'application/json'})
    }
    await info.attach('svelte-server.json',{body:JSON.stringify(await page.evaluate(()=>(window as any).svelteLogs??[])),contentType:'application/json'})
    await info.attach('svelte-browser.json',{body:JSON.stringify(diagnostics),contentType:'application/json'})
    await page.evaluate(()=>{(window as any).sveltePreview?.close();(window as any).svelteKernel?.close()})
  }
})
