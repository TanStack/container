import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
const root=realpathSync(process.env.SDK_OUTPUT)
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
const compute=count=>{let total=0;for(let i=0;i<count;i++)total=(total+i%97)%1000000007;return total}
let server,url
test.beforeAll(async()=>{
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname
 if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
 try{if(!path.startsWith('/sdk/'))throw Error();const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))));if(!file.startsWith(root+sep))throw Error();res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}})
 await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})
test('opt-in CPU fairness permits owner progress and cancellation during finite guest computation',async({page},info)=>{
 test.skip(manifest.buildProfile!=='experimental-fibers-simd-lazy-fairness','Requires explicit fairness profile')
 await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
 const observed=await page.evaluate(async compute=>{
  const evidence={rounds:[],cleanup:[]};let kernel,child
  try{
   kernel=new window.sdk.WorkerKernel({},{experimentalFibers:true,maxBytes:16*1024*1024,timeoutMs:5000})
   for(const cancel of [false,true]){
    const count=cancel?100000000:1000000,row={cancel,count,output:''};evidence.rounds.push(row)
    await kernel.writeText('/go.txt','wait');await kernel.writeText('/phase.txt','waiting')
    await kernel.writeText('/cpu.mjs',`import fs from 'node:fs';const memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true}),old=memory.buffer,view=new Int32Array(old);view[0]=41;console.log('READY');while(fs.readFileSync('/go.txt','utf8')!=='go')await new Promise(r=>setTimeout(r,1));fs.writeFileSync('/phase.txt','running');console.log('COMPUTING');const answer=(${compute})(${count});const previous=memory.grow(1);new Int32Array(memory.buffer)[0]++;console.log('MEMORY:'+JSON.stringify({previous,oldLength:old.byteLength,newLength:memory.buffer.byteLength,value:view[0],zero:new Uint8Array(memory.buffer,65536).every(x=>x===0)}));fs.writeFileSync('/phase.txt','done');console.log('ANSWER:'+answer);`)
    child=await kernel.spawn('node',['/cpu.mjs'],{lifetime:'session',guestWasm:true,maxBytes:16*1024*1024,timeoutMs:5000})
    const until=async marker=>{while(!row.output.includes(marker)){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr')row.output+=new TextDecoder().decode(event.bytes);if(!event||event.type==='exit')throw Error('Exited before '+marker+': '+row.output)}}
    await until('READY');await kernel.writeText('/go.txt','go');await until('COMPUTING')
    row.phaseDuringCompute=await kernel.readText('/phase.txt')
    if(cancel){await child.dispose();row.disposed=true;child=null;row.phaseAfterCancel=await kernel.readText('/phase.txt')}
    else{for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr')row.output+=new TextDecoder().decode(event.bytes);if(!event||event.type==='exit')break}row.exit=await child.wait();await child.dispose();child=null}
   }
   evidence.recovery=await kernel.execute('console.log(6*7)',{guestWasm:true,maxBytes:16*1024*1024,timeoutMs:5000})
  }catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}
  finally{if(child)try{await child.dispose()}catch(error){evidence.cleanup.push(error.message)}if(kernel)try{kernel.close()}catch(error){evidence.cleanup.push(error.message)}}
  return evidence
 },compute.toString())
 const path=info.outputPath('sdk-fairness.json');await writeFile(path,JSON.stringify({sdk:root,buildProfile:manifest.buildProfile,nativeAnswer:compute(1000000),observed},null,2));await info.attach('sdk-fairness.json',{path,contentType:'application/json'})
 expect(observed.failure,JSON.stringify(observed)).toBeUndefined();expect(observed.cleanup).toEqual([])
 expect(observed.rounds).toHaveLength(2)
 for(const row of observed.rounds)expect(row.phaseDuringCompute).toBe('running')
 expect(observed.rounds[0].exit.exitCode).toBe(0);expect(observed.rounds[0].output).toContain('ANSWER:'+compute(1000000))
 expect(observed.rounds[0].output).toContain('MEMORY:'+JSON.stringify({previous:1,oldLength:65536,newLength:131072,value:42,zero:true}))
 expect(observed.rounds[1].disposed).toBe(true);expect(observed.rounds[1].phaseAfterCancel).toBe('running')
 expect(observed.recovery.exitCode).toBe(0);expect(observed.recovery.stdout).toBe('42\n')
})
