import {test,expect} from '@playwright/test'
import {writeFile} from 'node:fs/promises'
import {startPackagedFrameworkDiagnostic} from './helpers/packaged-framework-diagnostic.mjs'

let diagnostic
test.beforeAll(async()=>{diagnostic=await startPackagedFrameworkDiagnostic('sdk-http-asset-diagnostic-')})
test.afterAll(async()=>{await diagnostic?.host.close()})

for(const delivery of ['ordinary','file-stream','parallel'])test('packaged runtime serves '+delivery+' large JavaScript assets',async({page},info)=>{
  test.setTimeout(90000)
  await page.goto(diagnostic.host.ownerOrigin)
  const results=await page.evaluate(async delivery=>{
    const {WorkerKernel,WorkerHTTP}=await import('/sdk/index.js')
    const {runtimes}=await(await fetch('/config.json')).json()
    const source=`import http from 'node:http';import fs from 'node:fs';http.createServer((req,res)=>{const size=Number(req.url.slice(1));res.setHeader('content-type','text/javascript');if(${JSON.stringify(delivery)}==='file-stream'){fs.writeFileSync('/asset.js','x'.repeat(size));res.setHeader('content-length',size);fs.createReadStream('/asset.js').pipe(res)}else res.end('x'.repeat(size))}).listen(8559,()=>console.log('READY'))`
    const kernel=new WorkerKernel({'/server.mjs':source},{assetBaseURL:new URL('/runtime/',location.href).href,...runtimes.start.kernelOptions,maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
    let child
    const rows=[]
    try{
      child=await kernel.spawn('node',['/server.mjs'],{guestWasm:true,webAPIs:true,lifetime:'session',maxBytes:128*1024*1024,timeoutMs:30000})
      let output=''
      for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr')output+=new TextDecoder().decode(event.bytes);if(output.includes('READY'))break;if(!event||event.type==='exit')throw Error('Server failed: '+output)}
      const http=new WorkerHTTP(kernel,8559)
      const request=async size=>{
        const row={size,started:performance.now()};rows.push(row)
        const response=await http.fetch(new Request('http://localhost/'+size))
        row.headersMs=performance.now()-row.started
        const body=await response.text()
        row.totalMs=performance.now()-row.started;row.status=response.status;row.length=body.length;row.contentMatches=body==='x'.repeat(size)
      }
      if(delivery==='parallel')await Promise.all(Array.from({length:10},(_,i)=>request([117,12110,901632][i%3])))
      else for(const size of [64*1024,256*1024,1024*1024])await request(size)
      return rows
    }finally{await child?.dispose();await kernel.close()}
  },delivery)
  const path=info.outputPath('http-assets.json')
  await writeFile(path,JSON.stringify({...diagnostic.evidence,diagnosticOnly:true,browser:info.project.name,results},null,2))
  await info.attach('http-assets.json',{path,contentType:'application/json'})
  for(const row of results){expect(row.status).toBe(200);expect(row.length).toBe(row.size);expect(row.contentMatches).toBe(true)}
})

test('packaged runtime retains encoded streaming chunks across delayed writes',async({page},info)=>{
  test.setTimeout(90000)
  await page.goto(diagnostic.host.ownerOrigin)
  const results=await page.evaluate(async()=>{
    const {WorkerKernel,WorkerHTTP}=await import('/sdk/index.js')
    const {runtimes}=await(await fetch('/config.json')).json()
    const source=`import http from 'node:http';
      let text='';for(let i=0;i<64;i++)text+='(self.$R=self.$R||{}); é水😀\\n';
      const encoder=new TextEncoder();
      const retained=encoder.encode(text);
      http.createServer(async(req,res)=>{
        const local=encoder.encode(text);
        res.setHeader('content-type','text/plain; charset=utf-8');
        res.write('prefix:');
        await new Promise(resolve=>setTimeout(resolve,20));
        for(let i=0;i<200;i++)encoder.encode('pressure'.repeat(1024));
        res.write(retained);
        await new Promise(resolve=>setTimeout(resolve,20));
        res.write(Buffer.from(local.buffer,local.byteOffset,local.byteLength));
        res.end(':suffix');
      }).listen(8559,()=>console.log('READY'))`
    const kernel=new WorkerKernel({'/server.mjs':source},{assetBaseURL:new URL('/runtime/',location.href).href,...runtimes.start.kernelOptions,maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
    let child
    const rows=[]
    try{
      child=await kernel.spawn('node',['/server.mjs'],{guestWasm:true,webAPIs:true,lifetime:'session',maxBytes:128*1024*1024,timeoutMs:30000})
      let output=''
      for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr')output+=new TextDecoder().decode(event.bytes);if(output.includes('READY'))break;if(!event||event.type==='exit')throw Error('Server failed: '+output)}
      const http=new WorkerHTTP(kernel,8559)
      const expected='prefix:'+'(self.$R=self.$R||{}); é水😀\n'.repeat(128)+':suffix'
      for(let i=0;i<3;i++){
        const response=await http.fetch(new Request('http://localhost/stream'))
        const body=await response.text()
        let mismatch=-1
        for(let j=0;j<Math.max(body.length,expected.length);j++)if(body[j]!==expected[j]){mismatch=j;break}
        rows.push({status:response.status,length:body.length,expectedLength:expected.length,contentMatches:body===expected,mismatch,sample:mismatch<0?'':body.slice(Math.max(0,mismatch-20),mismatch+100)})
      }
      return rows
    }finally{await child?.dispose();await kernel.close()}
  })
  const path=info.outputPath('http-streaming.json')
  await writeFile(path,JSON.stringify({...diagnostic.evidence,diagnosticOnly:true,browser:info.project.name,results},null,2))
  await info.attach('http-streaming.json',{path,contentType:'application/json'})
  for(const row of results){expect(row.status).toBe(200);expect(row.contentMatches).toBe(true)}
})
