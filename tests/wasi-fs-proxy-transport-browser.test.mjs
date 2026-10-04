import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {replaceWasiFsProxy} from '../scripts/wasi-fs-proxy-transport.mjs'

const require=createRequire(import.meta.url)
const runtime=process.env.NATIVE_WASI_FS_PROXY_RUNTIME_ROOT??dirname(require.resolve('@napi-rs/wasm-runtime'))
const version=JSON.parse(readFileSync(join(runtime,'package.json'))).version
assert.ok(['1.1.4','1.2.4'].includes(version))
const legacy=version==='1.1.4'
const upstream=readFileSync(join(runtime,'fs-proxy.js'),'utf8')
const transport=resolve('src/native/wasi-fs-transport.mjs')

async function bundle(contents,owned){
  const result=await build({stdin:{contents,resolveDir:process.cwd(),sourcefile:'wasi-transport-control.mjs'},
    bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',
    plugins:[{name:'pinned-wasi-codecs',setup(bundler){
      bundler.onResolve({filter:/^pinned-fs-proxy$/},()=>({path:'pinned-fs-proxy',namespace:'control'}))
      bundler.onLoad({filter:/.*/,namespace:'control'},()=>({contents:owned?replaceWasiFsProxy(upstream,transport):upstream,
        loader:'js',resolveDir:runtime}))
    }}]})
  return result.outputFiles[0].text
}

test('real desktop workers carry large replies and errors without replaying filesystem work',{
  skip:process.env.NATIVE_WASI_FS_PROXY_BROWSER_CONTROL!=='1'?'Opt-in desktop filesystem transport control':false,
  timeout:60000,
},async()=>{
  // Use the existing private pinned browser installation, without changing the
  // project lockfile or installing anything as part of this control.
  const runner=resolve(process.env.NATIVE_WASI_FS_PROXY_PLAYWRIGHT_ROOT??process.cwd())
  const runnerRequire=createRequire(join(runner,'package.json'))
  assert.equal(runnerRequire('@playwright/test/package.json').version,'1.63.0')
  const {chromium,firefox,webkit}=runnerRequire('@playwright/test')
  const workerSource=`import {Buffer} from 'buffer';
    import {createFsProxy} from 'pinned-fs-proxy';
    globalThis.Buffer=Buffer;
    class Stats{isDirectory(){return true}};
    const fs=createFsProxy({Stats});
    onmessage=event=>{if(event.data.command){
      try{let value;
        if(event.data.command==='binary'){
          const bytes=fs.readFileSync(event.data.size);
          value={length:bytes.length,first:bytes[0],last:bytes.at(-1),buffer:Buffer.isBuffer(bytes)};
        }else if(event.data.command==='directory')value=fs.readdirSync();
        else if(event.data.command==='stats'){
          const stat=fs.statSync();value={size:String(stat.size),directory:stat.isDirectory()};
        }else if(event.data.command==='buffer-read'){
          const bytes=Buffer.alloc(12,46),count=fs.readSync(0,bytes.subarray(2,10),1,3,0);
          value={count,text:bytes.toString()};
        }else if(event.data.command==='vector-read'){
          const bytes=Buffer.alloc(8,46),count=fs.readvSync(0,[bytes.subarray(1,5),bytes.subarray(3,7)],0);
          value={count,text:bytes.toString()};
        }else value=fs.errorSync();
        postMessage({done:true,value});
      }catch(error){postMessage({done:true,error:{name:error.name,message:error.message,code:error.code,stackLength:error.stack?.length}})}
    }};`
  const hostSource=`import {Buffer} from 'buffer';
    import {createOnMessage} from 'pinned-fs-proxy';
    import {manageWasiFilesystemWorker} from ${JSON.stringify(transport)};
    globalThis.Buffer=Buffer;
    class Stats{constructor(){this.size=1234567890123456789n}isDirectory(){return true}};
    globalThis.runControl=async(mode,command,size,action)=>new Promise((resolve,reject)=>{
      let operations=0,encodedBytes=0;
      const fs={Stats,
        readFileSync(size){operations++;return ${legacy?"'x'.repeat(size)":'Buffer.alloc(size,71)'}},
        readdirSync(){operations++;return Array.from({length:1200},(_,i)=>'file-'+String(i).padStart(5,'0'))},
        statSync(){operations++;return new Stats()},
        readSync(_fd,bytes,offset,length){operations++;bytes.fill(71,offset,offset+length);return length},
        readvSync(_fd,buffers){operations++;let count=0;for(let index=0;index<buffers.length;index++){
          buffers[index].fill(65+index);count+=buffers[index].byteLength;
        }return count},
        errorSync(){operations++;const error=new Error('original filesystem error');error.code='ENOENT';error.stack='frame\\n'.repeat(3000);throw error},
      };
      const handler=createOnMessage(fs),worker=new Worker('/'+mode+'-worker.mjs',{type:'module'});
      const wrapped=event=>{
        if(!event.data.__fs__)return;
        const request=event.data.__fs__;
        const originalRangeError=globalThis.RangeError;
        try{
          if(action==='long-fallback')globalThis.RangeError=class extends originalRangeError{
            constructor(...args){super(...args);this.stack='frame\\n'.repeat(3000)}
          };
          if(action==='dispose'&&request.continue)handler.dispose();
          handler(event);
          encodedBytes=Math.max(encodedBytes,Atomics.load(request.sab,2));
          if(action==='terminate'&&!request.continue){
            worker.terminate();resolve({terminated:true,operations,host:handler.inspect()});
          }
        }catch(error){
          const status=Atomics.load(request.sab,0);worker.terminate();
          resolve({hostError:error.message,status,operations});
        }finally{globalThis.RangeError=originalRangeError}
      };
      wrapped.dispose=()=>handler.dispose();
      if(mode==='owned')manageWasiFilesystemWorker(worker,wrapped);
      else worker.addEventListener('message',wrapped);
      worker.addEventListener('error',event=>{worker.terminate();reject(Error(event.message))});
      worker.addEventListener('message',event=>{if(event.data.done){
        worker.terminate();resolve({...event.data,operations,encodedBytes,host:handler.inspect?.()});
      }});
      worker.postMessage({command,size});
    });`
  const routes=new Map()
  for(const mode of ['raw','owned']){
    routes.set('/'+mode+'-worker.mjs',await bundle(workerSource,mode==='owned'))
    routes.set('/'+mode+'-host.mjs',await bundle(hostSource,mode==='owned'))
  }
  const server=createServer((request,response)=>{
    const script=routes.get(request.url)
    response.writeHead(200,{'Content-Type':script?'text/javascript':'text/html',
      'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'})
    response.end(script??'<!doctype html><title>WASI filesystem transport control</title>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin='http://127.0.0.1:'+server.address().port
  try{for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage()
      await page.goto(origin)
      await page.addScriptTag({url:origin+'/raw-host.mjs',type:'module'})
      const rawLarge=await page.evaluate(()=>runControl('raw','binary',10241))
      assert.equal(rawLarge.error.message,'payload overflow',engine.name())
      const rawBuffer=await page.evaluate(()=>runControl('raw','buffer-read'))
      assert.deepEqual(rawBuffer.value,{count:3,text:'............'},engine.name())
      const rawError=await page.evaluate(()=>runControl('raw','error',undefined,'long-fallback'))
      assert.equal(rawError.hostError,'payload overflow');assert.equal(rawError.status,21)
      await page.addScriptTag({url:origin+'/owned-host.mjs',type:'module'})
      for(const size of [0,1,10239,10240,10241,20480,20481,1024*1024]){
        const row=await page.evaluate(size=>runControl('owned','binary',size),size)
        assert.deepEqual(row.value,{length:size,first:size?(legacy?'x':71):undefined,
          last:size?(legacy?'x':71):undefined,buffer:!legacy},engine.name())
        assert.equal(row.operations,1);assert.deepEqual(row.host,{disposed:true,pendingBytes:0})
      }
      const directory=await page.evaluate(()=>runControl('owned','directory'))
      assert.equal(directory.value.length,1200);assert.equal(directory.value.at(-1),'file-01199')
      const stats=await page.evaluate(()=>runControl('owned','stats'))
      assert.deepEqual(stats.value,{size:'1234567890123456789',directory:true})
      const buffer=await page.evaluate(()=>runControl('owned','buffer-read'))
      assert.deepEqual(buffer.value,{count:3,text:'...GGG......'},engine.name());assert.equal(buffer.operations,1)
      const vector=await page.evaluate(()=>runControl('owned','vector-read'))
      assert.deepEqual(vector.value,{count:8,text:'.AABBBB.'},engine.name());assert.equal(vector.operations,1)
      const error=await page.evaluate(()=>runControl('owned','error'))
      assert.equal(error.error.code,'ENOENT');assert.equal(error.error.message,'original filesystem error')
      // The unchanged upstream decoder recreates the stack in the worker. The
      // encoded original stack still crosses the transport without overflowing.
      assert.ok(error.encodedBytes>10240);assert.equal(error.operations,1)
      const disposed=await page.evaluate(()=>runControl('owned','binary',80000,'dispose'))
      assert.equal(disposed.error.message,'WASI filesystem host disposed')
      assert.equal(disposed.operations,1);assert.deepEqual(disposed.host,{disposed:true,pendingBytes:0})
      const terminated=await page.evaluate(()=>runControl('owned','binary',80000,'terminate'))
      assert.equal(terminated.terminated,true);assert.equal(terminated.operations,1)
      assert.deepEqual(terminated.host,{disposed:true,pendingBytes:0})
      console.log(JSON.stringify({browser:engine.name(),version:browser.version(),codecVersion:version,rawLarge:rawLarge.error.message,
        rawErrorStatus:rawError.status,binarySizes:legacy?0:8,stringSizes:legacy?8:0,largeDirectory:true,largeError:true,bigintStats:true,
        ordinaryBufferRead:true,overlappingVectorRead:true,disposed:true,terminated:true,operationsReplayed:0,passed:true}))
    }finally{await browser.close()}
  }}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
