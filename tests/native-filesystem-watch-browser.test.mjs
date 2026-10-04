import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {build} from 'esbuild'
import {replaceWasiFsProxy} from '../scripts/wasi-fs-proxy-transport.mjs'

test('desktop workers watch one service-owned filesystem with independent endpoint cleanup',{
  skip:process.env.NATIVE_FILESYSTEM_WATCH_BROWSER_CONTROL!=='1'?'Opt-in desktop remote watcher control':false,timeout:60000,
},async()=>{
  const runner=resolve(process.env.NATIVE_FILESYSTEM_WATCH_PLAYWRIGHT_ROOT)
  const runnerRequire=createRequire(join(runner,'package.json'))
  assert.equal(runnerRequire('@playwright/test/package.json').version,'1.63.0')
  const {chromium,firefox,webkit}=runnerRequire('@playwright/test')
  const require=createRequire(import.meta.url),runtime=dirname(require.resolve('@napi-rs/wasm-runtime'))
  assert.equal(JSON.parse(readFileSync(join(runtime,'package.json'))).version,'1.2.4')
  async function bundle(contents){
    const result=await build({stdin:{contents,resolveDir:process.cwd(),sourcefile:'watcher-browser-control.mjs'},
      bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',
      alias:{'node:buffer':'buffer/','node:events':'events/','node:stream':'stream-browserify','node:path':'path-browserify'},
      plugins:[{name:'owned-pinned-filesystem-codec',setup(bundler){
        bundler.onResolve({filter:/^pinned-fs-proxy$/},()=>({path:'pinned-fs-proxy',namespace:'control'}))
        bundler.onLoad({filter:/.*/,namespace:'control'},()=>({loader:'js',resolveDir:runtime,
          contents:replaceWasiFsProxy(readFileSync(join(runtime,'fs-proxy.js'),'utf8'),resolve('src/native/wasi-fs-transport.mjs'))+'\nexport {decodeValue};'}))
      }}]})
    return result.outputFiles[0].text
  }
  const service=await bundle(`
    import {Buffer} from 'buffer';globalThis.Buffer=Buffer;
    import {createNativeFilesystemBackend} from './src/native/filesystem-backend.mjs';
    import {createWasiFilesystemService} from './src/native/wasi-filesystem-service.mjs';
    import {createOnMessage} from 'pinned-fs-proxy';
    const {fs}=createNativeFilesystemBackend();fs.mkdirSync('/app/nested',{recursive:true});fs.writeFileSync('/app/nested/file','before');
    const service=createWasiFilesystemService(fs,createOnMessage);
    onmessage=({data})=>{
      if(data.type==='control'){const port=data.port;port.onmessage=service.onMessage;port.start();}
      else if(data.type==='inspect')postMessage({...service.inspect(),...service.inspectWatchers()});
    };
  `)
  const client=await bundle(`
    import {Buffer} from 'buffer';globalThis.Buffer=Buffer;
    import {fs as constructors} from 'memfs';
    import {decodeValue} from 'pinned-fs-proxy';
    import {createWasiFilesystemClient} from './src/native/wasi-fs-transport.mjs';
    import {createWasiFilesystemEndpoint} from './src/native/wasi-filesystem-service.mjs';
    import {createNativeFilesystemWatchClient} from './src/native/filesystem-watch-client.mjs';
    let fs,endpoint,watchClient;const events=[];
    onmessage=({data})=>{
      try{
        if(data.type==='start'){
          endpoint=createWasiFilesystemEndpoint(data.port,data.id);
          fs=createWasiFilesystemClient(constructors,{decodeValue,timeoutMs:3000,send:message=>endpoint.port.postMessage(message)});
          watchClient=createNativeFilesystemWatchClient(fs,endpoint.port);
          fs.statSync('/app');postMessage({ready:true});
        }else if(data.type==='watch'){
          const watcher=watchClient.watch('/app',{recursive:true,encoding:'buffer'});
          watcher.on('change',(event,name)=>{events.push({event,name:name.toString(),buffer:Buffer.isBuffer(name)});postMessage({change:events.at(-1)});});
          postMessage({watching:true});
        }else if(data.type==='write'){
          fs.writeFileSync('/app/nested/file',data.text);postMessage({written:true});
        }else if(data.type==='burst'){
          fs.statSync('/app/nested/file');const before=events.length;
          for(let index=0;index<1000;index++)fs.writeFileSync('/app/nested/file','burst '+index);
          postMessage({burstWritten:true,before});
        }else if(data.type==='event-state'){
          postMessage({eventState:true,count:events.length,text:fs.readFileSync('/app/nested/file','utf8')});
        }else if(data.type==='dispose'){
          watchClient.dispose();fs.statSync('/app');endpoint.dispose();postMessage({disposed:true,...watchClient.inspect()});
        }
      }catch(error){postMessage({error:{message:error.message,code:error.code}});}
    };
  `)
  const host=await bundle(`
    globalThis.runWatchControl=async()=>{
      const service=new Worker('/service.mjs',{type:'module'}),first=new Worker('/client.mjs',{type:'module'}),second=new Worker('/client.mjs',{type:'module'});
      const pending=(worker,predicate)=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{worker.removeEventListener('message',receive);reject(Error('Watcher control timed out'));},5000);
        function receive({data}){if(data.error){clearTimeout(timer);worker.removeEventListener('message',receive);reject(Error(data.error.message));}
          else if(predicate(data)){clearTimeout(timer);worker.removeEventListener('message',receive);resolve(data);}}
        worker.addEventListener('message',receive);
      });
      const command=(worker,data,predicate)=>{const reply=pending(worker,predicate);worker.postMessage(data);return reply;};
      try{
        for(const [worker,id] of [[first,'first'],[second,'second']]){
          const {port1,port2}=new MessageChannel();service.postMessage({type:'control',port:port1},[port1]);
          const ready=pending(worker,data=>data.ready);worker.postMessage({type:'start',id,port:port2},[port2]);await ready;
          await command(worker,{type:'watch'},data=>data.watching);
        }
        const initial=await command(service,{type:'inspect'},()=>true);
        const changes=[pending(first,data=>data.change),pending(second,data=>data.change)];
        await command(second,{type:'write',text:'changed'},data=>data.written);
        const both=await Promise.all(changes);
        await command(first,{type:'dispose'},data=>data.disposed);
        // The first client's release and inspection use different control ports,
        // so wait for authoritative state rather than assuming their ordering.
        let remaining;
        for(let attempt=0;attempt<20;attempt++){
          remaining=await command(service,{type:'inspect'},()=>true);
          if(remaining.clients===1&&remaining.watches===1)break;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        const change=pending(second,data=>data.change);
        await command(second,{type:'write',text:'still alive'},data=>data.written);const survivor=await change;
        const burst=await command(second,{type:'burst'},data=>data.burstWritten);
        let burstState;
        for(let attempt=0;attempt<100;attempt++){
          burstState=await command(service,{type:'inspect'},()=>true);
          if(burstState.pendingEvents===0&&burstState.inFlightEvents===0)break;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        const observed=await command(second,{type:'event-state'},data=>data.eventState);
        const pressure={writes:1000,notifications:observed.count-burst.before,text:observed.text,...burstState};
        await command(second,{type:'dispose'},data=>data.disposed);
        let final;
        for(let attempt=0;attempt<20;attempt++){
          final=await command(service,{type:'inspect'},()=>true);
          if(final.clients===0&&final.watches===0)break;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        return {initial,both,remaining,survivor,pressure,final};
      }finally{first.terminate();second.terminate();service.terminate();}
    };
  `)
  const routes=new Map([['/service.mjs',service],['/client.mjs',client],['/host.mjs',host]])
  const server=createServer((request,response)=>{
    const script=routes.get(request.url)
    response.writeHead(200,{'Content-Type':script?'text/javascript':'text/html',
      'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'})
    response.end(script??'<!doctype html><title>Remote filesystem watcher control</title>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin='http://127.0.0.1:'+server.address().port
  try{for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage();await page.goto(origin);await page.addScriptTag({url:origin+'/host.mjs',type:'module'})
      const result=await page.evaluate(()=>runWatchControl())
      assert.equal(result.initial.clients,2);assert.equal(result.initial.watches,2)
      assert.ok(result.both.every(({change})=>change.event==='change'&&change.name==='nested/file'&&change.buffer))
      assert.equal(result.remaining.clients,1);assert.equal(result.remaining.watches,1)
      assert.equal(result.survivor.change.name,'nested/file')
      assert.equal(result.pressure.notifications,2);assert.equal(result.pressure.text,'burst 999')
      assert.equal(result.pressure.pendingEvents,0);assert.equal(result.pressure.inFlightEvents,0)
      assert.equal(result.final.clients,0);assert.equal(result.final.watches,0);assert.equal(result.final.descriptors,0)
      assert.equal(result.final.pendingEvents,0);assert.equal(result.final.inFlightEvents,0)
      console.log(JSON.stringify({browser:engine.name(),version:browser.version(),...result,passed:true}))
    }finally{await browser.close()}
  }}finally{await new Promise(resolve=>server.close(resolve))}
})
