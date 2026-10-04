import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {Module,createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {build} from 'esbuild'
import {replaceWasiFsProxy} from '../scripts/wasi-fs-proxy-transport.mjs'
import {loadFilesystemCodecs} from './fixtures/wasi-filesystem-codecs.mjs'

test('desktop installer and terminal consumers use a separate authoritative filesystem worker',{
  skip:process.env.NATIVE_FILESYSTEM_CONSUMERS_BROWSER_CONTROL!=='1'?'Opt-in desktop remote consumer control':false,timeout:60000,
},async()=>{
  const runnerRequire=createRequire(join(resolve(process.env.NATIVE_FILESYSTEM_CONSUMERS_PLAYWRIGHT_ROOT),'package.json'))
  assert.equal(runnerRequire('@playwright/test/package.json').version,'1.63.0')
  const {chromium,firefox,webkit}=runnerRequire('@playwright/test')
  const require=createRequire(import.meta.url),runtime=dirname(require.resolve('@napi-rs/wasm-runtime'))
  assert.equal(JSON.parse(readFileSync(join(runtime,'package.json'))).version,'1.2.4')
  const codecs=loadFilesystemCodecs()
  const fixtureBuild=await build({entryPoints:[resolve('tests/fixtures/npm-project.ts')],bundle:true,write:false,platform:'node',format:'cjs'})
  const fixtureModule=new Module(resolve('tests/native-filesystem-browser-fixture.cjs'))
  fixtureModule._compile(fixtureBuild.outputFiles[0].text,fixtureModule.id)
  const fixture=fixtureModule.exports.npmProject()
  const project={files:fixture.files,archives:Object.fromEntries(Object.entries(fixture.archives).map(([url,bytes])=>[url,[...bytes]]))}
  async function bundle(contents){
    const result=await build({stdin:{contents,resolveDir:process.cwd(),sourcefile:'filesystem-consumer-control.mjs'},
      bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',
      alias:{'node:buffer':'buffer/','node:events':'events/','node:stream':'stream-browserify','node:path':'path-browserify'},
      plugins:[{name:'owned-pinned-filesystem-codec',setup(bundler){
        bundler.onResolve({filter:/^pinned-fs-proxy(?:-114)?$/},({path})=>({path,namespace:'control'}))
        bundler.onLoad({filter:/.*/,namespace:'control'},({path})=>{
          const codec=codecs[path==='pinned-fs-proxy-114'?'1.1.4':'1.2.4']
          return {loader:'js',resolveDir:codec.root,
            contents:replaceWasiFsProxy(codec.source,resolve('src/native/wasi-fs-transport.mjs'))+'\nexport {decodeValue};'}
        })
      }}]})
    return result.outputFiles[0].text
  }
  const service=await bundle(`
    import {Buffer} from 'buffer';globalThis.Buffer=Buffer;
    import {createNativeFilesystemBackend} from './src/native/filesystem-backend.mjs';
    import {createWasiFilesystemService} from './src/native/wasi-filesystem-service.mjs';
    import {createOnMessage} from 'pinned-fs-proxy';
    import {createOnMessage as createOldOnMessage} from 'pinned-fs-proxy-114';
    const {fs}=createNativeFilesystemBackend();fs.mkdirSync('/app',{recursive:true});
    const service=createWasiFilesystemService(fs,{'1.1.4':createOldOnMessage,'1.2.4':createOnMessage});
    onmessage=({data})=>{
      if(data.type==='control'){const port=data.port;port.onmessage=service.onMessage;port.start();}
      else if(data.type==='inspect')postMessage({...service.inspect(),...service.inspectWatchers()});
    };
  `)
  const client=await bundle(`
    import {Buffer} from 'buffer';globalThis.Buffer=Buffer;
    import {fs as constructors} from 'memfs';
    import {decodeValue} from 'pinned-fs-proxy';
    import {decodeValue as decodeOldValue} from 'pinned-fs-proxy-114';
    import {createWasiFilesystemClient} from './src/native/wasi-fs-transport.mjs';
    import {createWasiFilesystemEndpoint} from './src/native/wasi-filesystem-service.mjs';
    import {nativeFileOperationNames,runFilesystemConsumerControl} from './tests/fixtures/native-filesystem-consumer-workload.ts';
    import {runFilesystemAsyncControl} from './tests/fixtures/native-filesystem-async-workload.mjs';
    import {runFilesystemStreamControl} from './tests/fixtures/native-filesystem-stream-workload.mjs';
    import nodeFs,{resetVolume,setNativeSyncFileClient} from './src/vite-browser/node-fs.ts';
    import {NativeTerminalFileSession} from './src/native/terminal-file-session.ts';
    const endpoints=[];let volume,observer,asyncFilesystem;
    onmessage=async({data})=>{
      try{
        if(data.type==='start'){
          const connect=(id,codec='1.2.4')=>{
            const endpoint=createWasiFilesystemEndpoint(data.port,id,{codec});endpoints.push(endpoint);
            const fs=createWasiFilesystemClient(constructors,{decodeValue:codec==='1.1.4'?decodeOldValue:decodeValue,timeoutMs:3000,send:message=>endpoint.port.postMessage(message)});
            if(id==='consumer')asyncFilesystem=new Proxy(fs,{get(target,key){return key==='constants'?constructors.constants:Reflect.get(target,key);}});
            return Object.fromEntries(nativeFileOperationNames.map(method=>[method,(...args)=>fs[method](...args)]));
          };
          volume=connect('consumer');observer=connect('observer');
          globalThis.olderCodecFilesystem=connect('oxide','1.1.4');
          volume.statSync('/app');postMessage({ready:true});
        }else if(data.type==='exercise'){
          const result=await runFilesystemConsumerControl(volume,observer,data.project);
          const async=await runFilesystemAsyncControl(asyncFilesystem);
          const streams=await runFilesystemStreamControl(asyncFilesystem);
          resetVolume({'/app/package.json':'{}'});
          const localStreams=await runFilesystemStreamControl(nodeFs,nodeFs);
          const session=new NativeTerminalFileSession(volume);
          setNativeSyncFileClient({call:(method,args)=>session.call(method,args)});
          let childStreams;
          try{childStreams=await runFilesystemStreamControl(nodeFs,nodeFs);}
          finally{setNativeSyncFileClient(undefined);session.close();}
          const older=globalThis.olderCodecFilesystem,codecChecks=[];
          const check=(name,passed)=>{if(!passed)throw Error(name);codecChecks.push(name);};
          const root=older.openSync('/','r'),rootInode=older.fstatSync(root,{bigint:true}).ino;
          volume.mkdirSync('/codec-workspace');
          check('preopened root survives another codec mount',volume.fstatSync(root,{bigint:true}).ino===rootInode&&volume.fstatSync(root).isDirectory());
          const bytes=Uint8Array.from({length:260000},(_,i)=>i%251);volume.writeFileSync('/codec-workspace/large',bytes);
          const received=older.readFileSync('/codec-workspace/large');
          check('older codec retains chunked binary bytes',received.length===bytes.length&&received.every((value,index)=>value===bytes[index]));
          older.symlinkSync('large','/codec-workspace/link');
          check('newer codec sees original symlink metadata',volume.lstatSync('/codec-workspace/link').isSymbolicLink()&&volume.readlinkSync('/codec-workspace/link')==='large');
          const entries=older.readdirSync('/codec-workspace',{withFileTypes:true});
          check('older codec restores directory constructors',entries.find(entry=>entry.name==='large').isFile()&&entries.find(entry=>entry.name==='link').isSymbolicLink());
          const fd=older.openSync('/codec-workspace/large','r+'),buffer=Buffer.alloc(4);
          volume.readSync(fd,buffer,0,4,null);check('newer codec reads older descriptor',buffer.every((value,index)=>value===bytes[index]));
          older.readSync(fd,buffer,0,4,null);check('both codecs share one implicit cursor',buffer.every((value,index)=>value===bytes[index+4]));
          volume.writeSync(fd,Buffer.from('changed'),0,7,100);older.readSync(fd,buffer,0,4,null);
          check('positioned write does not seek shared cursor',buffer.every((value,index)=>value===bytes[index+8]));
          check('older codec retains bigint stats',older.statSync('/codec-workspace/large',{bigint:true}).size===260000n);
          for(const [name,fs]of [['older',older],['newer',volume]])for(const options of [undefined,{bigint:true}]){
            for(const [method,target]of [['statSync','/codec-workspace/large'],['lstatSync','/codec-workspace/link'],['fstatSync',fd]]){
              const stat=fs[method](target,options);
              check(name+' codec '+method+' '+(options?'bigint':'number')+' retains Date timestamps',
                ['atime','mtime','ctime','birthtime'].every(field=>stat[field] instanceof Date&&
                  stat[field].getTime()===Number(stat[field+'Ms'])&&
                  stat[field].toJSON()===new Date(Number(stat[field+'Ms'])).toJSON()));
            }
          }
          for(const [name,fs]of [['older',older],['newer',volume]]){
            let code;try{fs.readFileSync('/codec-workspace/missing');}catch(error){code=error.code;}
            check(name+' codec retains original filesystem errors',code==='ENOENT');
          }
          volume.closeSync(fd);volume.closeSync(root);
          postMessage({result,async,streams,localStreams,childStreams,codecs:{checks:codecChecks,passed:true}});
        }
        else if(data.type==='dispose'){for(const endpoint of endpoints)endpoint.dispose();postMessage({disposed:true});}
      }catch(error){postMessage({error:{message:error.message,stack:error.stack,code:error.code}});}
    };
  `)
  const host=await bundle(`
    globalThis.runConsumerControl=async(project)=>{
      const service=new Worker('/service.mjs',{type:'module'}),client=new Worker('/client.mjs',{type:'module'});
      const pending=(worker,predicate)=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{worker.removeEventListener('message',receive);reject(Error('Filesystem consumer control timed out'));},10000);
        function receive({data}){if(data.error){clearTimeout(timer);worker.removeEventListener('message',receive);reject(Error(data.error.stack||data.error.message));}
          else if(predicate(data)){clearTimeout(timer);worker.removeEventListener('message',receive);resolve(data);}}
        worker.addEventListener('message',receive);
      });
      const command=(worker,data,predicate)=>{const reply=pending(worker,predicate);worker.postMessage(data);return reply;};
      try{
        const {port1,port2}=new MessageChannel();service.postMessage({type:'control',port:port1},[port1]);
        const ready=pending(client,data=>data.ready);client.postMessage({type:'start',port:port2},[port2]);await ready;
        const {result,async,streams,localStreams,childStreams,codecs}=await command(client,{type:'exercise',project},data=>data.result);
        const active=await command(service,{type:'inspect'},()=>true);
        await command(client,{type:'dispose'},data=>data.disposed);
        let final;
        for(let attempt=0;attempt<20;attempt++){
          final=await command(service,{type:'inspect'},()=>true);
          if(final.clients===0)break;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        return {result,async,streams,localStreams,childStreams,codecs,active,final};
      }finally{client.terminate();service.terminate();}
    };
  `)
  const routes=new Map([['/service.mjs',service],['/client.mjs',client],['/host.mjs',host]])
  const server=createServer((request,response)=>{
    const script=routes.get(request.url)
    response.writeHead(200,{'Content-Type':script?'text/javascript':'text/html',
      'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'})
    response.end(script??'<!doctype html><title>Remote filesystem consumer control</title>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin='http://127.0.0.1:'+server.address().port
  try{for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage();await page.goto(origin);await page.addScriptTag({url:origin+'/host.mjs',type:'module'})
      const result=await page.evaluate(project=>runConsumerControl(project),project)
      assert.equal(result.result.passed,true);assert.equal(result.result.checks.length,14)
      assert.equal(result.async.passed,true);assert.equal(result.async.checks.length,14)
      assert.equal(result.streams.passed,true);assert.equal(result.streams.checks.length,14)
      assert.equal(result.localStreams.passed,true);assert.equal(result.localStreams.checks.length,14)
      assert.equal(result.childStreams.passed,true);assert.equal(result.childStreams.checks.length,14)
      assert.equal(result.codecs.passed,true);assert.equal(result.codecs.checks.length,22)
      assert.equal(result.active.clients,3);assert.equal(result.active.descriptors,0)
      assert.equal(result.final.clients,0);assert.equal(result.final.descriptors,0);assert.equal(result.final.watches,0)
      console.log(JSON.stringify({browser:engine.name(),version:browser.version(),...result,passed:true}))
    }finally{await browser.close()}
  }}finally{await new Promise(resolve=>server.close(resolve))}
})
