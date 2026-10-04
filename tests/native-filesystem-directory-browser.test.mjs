import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {join,resolve} from 'node:path'
import {build} from 'esbuild'
import {replaceWasiFsProxy} from '../scripts/wasi-fs-proxy-transport.mjs'
import {loadFilesystemCodecs} from './fixtures/wasi-filesystem-codecs.mjs'

test('directory handles and public Node exports work in every desktop engine',{
  skip:process.env.NATIVE_DIRECTORY_BROWSER_CONTROL!=='1'?'Opt-in desktop directory control':false,timeout:60000,
},async()=>{
  const runner=createRequire(join(resolve(process.env.NATIVE_DIRECTORY_PLAYWRIGHT_ROOT),'package.json'))
  assert.equal(runner('@playwright/test/package.json').version,'1.63.0')
  const {chromium,firefox,webkit}=runner('@playwright/test'),codecs=loadFilesystemCodecs()
  const bundle=async contents=>(await build({stdin:{contents,resolveDir:process.cwd(),sourcefile:'directory-browser-control.mjs'},
    bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',
    alias:{'node:buffer':'buffer/','node:events':'events/','node:stream':'stream-browserify','node:path':'path-browserify'},
    plugins:[{name:'pinned-directory-codecs',setup(builder){
      builder.onResolve({filter:/^directory-codec-/},({path})=>({path,namespace:'codec'}))
      builder.onLoad({filter:/.*/,namespace:'codec'},({path})=>{
        const input=codecs[path.slice('directory-codec-'.length)]
        return {loader:'js',resolveDir:input.root,
          contents:replaceWasiFsProxy(input.source,resolve('src/native/wasi-fs-transport.mjs'))+'\nexport {decodeValue};'}
      })
    }}]})).outputFiles[0].text
  const service=await bundle(`
    import {Buffer} from 'buffer';globalThis.Buffer=Buffer;
    import {createNativeFilesystemBackend} from './src/native/filesystem-backend.mjs';
    import {createWasiFilesystemService} from './src/native/wasi-filesystem-service.mjs';
    import {createOnMessage as oldCodec} from 'directory-codec-1.1.4';
    import {createOnMessage as newCodec} from 'directory-codec-1.2.4';
    const {fs}=createNativeFilesystemBackend();fs.mkdirSync('/app',{recursive:true});
    const service=createWasiFilesystemService(fs,{'1.1.4':oldCodec,'1.2.4':newCodec});
    onmessage=({data})=>{
      if(data.type==='control'){data.port.onmessage=service.onMessage;data.port.start();}
      else if(data.type==='release'){service.releaseScope(data.id);postMessage({released:true});}
      else if(data.type==='inspect')postMessage({...service.inspect(),...service.inspectDirectories()});
    };
  `)
  const client=await bundle(`
    import {Buffer} from 'buffer';globalThis.Buffer=Buffer;
    import {fs as constructors} from 'memfs';
    import {decodeValue as oldCodec} from 'directory-codec-1.1.4';
    import {decodeValue as newCodec} from 'directory-codec-1.2.4';
    import {createWasiFilesystemClient} from './src/native/wasi-fs-transport.mjs';
    import {createWasiFilesystemEndpoint} from './src/native/wasi-filesystem-service.mjs';
    import {createNativeFilesystemClientApi} from './src/native/filesystem-client-api.mjs';
    import {installNativeFilesystemProvider} from './src/native/filesystem-provider.mjs';
    import {runDirectoryControl} from './tests/fixtures/native-filesystem-directory-workload.mjs';
    let client,directory;
    onmessage=async({data})=>{try{
      if(data.type==='start'){
        const endpoint=createWasiFilesystemEndpoint(data.port,data.id,{codec:data.codec});
        const raw=createWasiFilesystemClient(constructors,{decodeValue:data.codec==='1.1.4'?oldCodec:newCodec,
          timeoutMs:3000,send:message=>endpoint.port.postMessage(message)});
        client=createNativeFilesystemClientApi(raw,constructors,endpoint.port);
        installNativeFilesystemProvider(client);
        const node=await import('./src/vite-browser/node-fs.ts');
        const promises=await import('./src/vite-browser/node-fs-promises.ts');
        const result=await runDirectoryControl(node.default,'/app/'+data.id);
        const named=node.opendirSync('/app/'+data.id);
        if(!(named instanceof node.Dir)||!(named.readSync() instanceof node.Dirent))throw Error('Named Dir exports');
        named.closeSync();
        const callback=await new Promise((resolve,reject)=>node.opendir('/app/'+data.id,(error,value)=>error?reject(error):resolve(value)));
        callback.closeSync();
        const promised=await promises.opendir('/app/'+data.id);await promised.close();
        directory=node.opendirSync('/app/'+data.id,{bufferSize:1});
        postMessage({result,publicExports:true,ready:true});
      }else if(data.type==='read')postMessage({survived:directory.readSync()!==null});
      else if(data.type==='dispose'){client.dispose();postMessage({disposed:true});}
    }catch(error){postMessage({error:{message:error.message,stack:error.stack,code:error.code}});}};
  `)
  const host=`
    globalThis.runDirectoryBrowserControl=async()=>{
      const service=new Worker('/service.mjs',{type:'module'}),clients=[];
      const pending=worker=>new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error('Directory browser control timed out')),10000);
        const receive=({data})=>{clearTimeout(timeout);worker.removeEventListener('message',receive);
          data.error?reject(Error(data.error.stack||data.error.message)):resolve(data);};
        worker.addEventListener('message',receive);worker.addEventListener('error',event=>{clearTimeout(timeout);reject(Error(event.message));},{once:true});
      });
      const command=(worker,data)=>{const response=pending(worker);worker.postMessage(data);return response;};
      try{
        const results=[];
        for(const codec of ['1.1.4','1.2.4']){
          const worker=new Worker('/client.mjs',{type:'module'});clients.push(worker);
          const {port1,port2}=new MessageChannel();service.postMessage({type:'control',port:port1},[port1]);
          const ready=pending(worker);worker.postMessage({type:'start',id:'codec-'+codec,codec,port:port2},[port2]);
          results.push({codec,...await ready});
        }
        const initial=await command(service,{type:'inspect'});
        clients[0].terminate();await command(service,{type:'release',id:'codec-1.1.4'});
        const remaining=await command(service,{type:'inspect'});
        const sibling=await command(clients[1],{type:'read'});
        await command(clients[1],{type:'dispose'});
        const final=await command(service,{type:'inspect'});
        return {results,initial,remaining,sibling,final};
      }finally{for(const worker of clients)worker.terminate();service.terminate();}
    };
  `
  const routes=new Map([['/service.mjs',service],['/client.mjs',client],['/host.mjs',host]])
  const server=createServer((request,response)=>{
    const script=routes.get(request.url)
    response.writeHead(200,{'Content-Type':script?'text/javascript':'text/html',
      'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'})
    response.end(script??'<!doctype html><title>Directory handle control</title>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin='http://127.0.0.1:'+server.address().port
  try{for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage(),errors=[]
      page.on('pageerror',error=>errors.push(error.message))
      page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
      await page.goto(origin);await page.addScriptTag({url:origin+'/host.mjs',type:'module'})
      const result=await page.evaluate(()=>runDirectoryBrowserControl())
      assert.ok(result.results.every(item=>item.result.passed&&item.publicExports))
      assert.equal(result.initial.directories,2);assert.equal(result.remaining.directories,1)
      assert.equal(result.sibling.survived,true);assert.equal(result.final.directories,0)
      assert.deepEqual(errors,[])
      console.log(JSON.stringify({browser:engine.name(),version:browser.version(),...result,errors,passed:true}))
    }finally{await browser.close()}
  }}finally{await new Promise(resolve=>server.close(resolve))}
})
