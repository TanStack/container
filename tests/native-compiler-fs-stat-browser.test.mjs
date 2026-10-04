import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {dirname,join,resolve} from 'node:path'
import {build} from 'esbuild'

const root=resolve('.')
const sha=value=>createHash('sha256').update(value).digest('hex')

test('installed WASI consumes local and session-backed stats in all desktop engines',{
  skip:process.env.NATIVE_COMPILER_FS_BROWSER_CONTROL!=='1'?'Opt-in desktop compiler stat control':false,
  timeout:60000,
},async()=>{
  const require=createRequire(import.meta.url)
  const runtimeRoot=dirname(require.resolve('@napi-rs/wasm-runtime'))
  assert.equal(JSON.parse(readFileSync(join(runtimeRoot,'package.json'))).version,'1.2.4')
  const runner=resolve(process.env.NATIVE_COMPILER_FS_PLAYWRIGHT_ROOT??root)
  const runnerRequire=createRequire(join(runner,'package.json'))
  for(const name of ['@playwright/test','playwright','playwright-core'])
    assert.equal(runnerRequire(`${name}/package.json`).version,'1.63.0')
  const {chromium,firefox,webkit}=runnerRequire('@playwright/test')
  const inputs=['src/vite-browser/node-fs.ts','src/native/terminal-file-session.ts',
    'tests/native-compiler-fs-stat-browser.test.mjs','package-lock.json','pnpm-lock.yaml']
  const identity=()=>Object.fromEntries(inputs.map(file=>[file,sha(readFileSync(join(root,file)))]))
  const before=identity()
  const source=`import {WASI} from '@tybys/wasm-util';
    import {Volume} from 'memfs';
    import fs,{resetVolume,setNativeSyncFileClient} from './src/vite-browser/node-fs.ts';
    import {NativeTerminalFileSession} from './src/native/terminal-file-session.ts';
    const reactor=new WebAssembly.Module(new Uint8Array([
      0,97,115,109,1,0,0,0,5,3,1,0,1,7,10,1,6,109,101,109,111,114,121,2,0]));
    globalThis.runStatControl=async live=>{
      setNativeSyncFileClient(undefined);
      resetVolume({'/app/input.txt':'content'});
      const volume=Volume.fromJSON({'/app/input.txt':'content'});
      const session=new NativeTerminalFileSession(volume);
      if(live)setNativeSyncFileClient({call:(method,args)=>session.call(method,args)});
      let wasi,fd;
      try{
        fd=fs.openSync('/app/input.txt','r');
        const normal=fs.fstatSync(fd),big=fs.fstatSync(fd,{bigint:true});
        const callback=await new Promise((resolve,reject)=>fs.fstat(fd,{bigint:true},
          (error,value)=>error?reject(error):resolve(value)));
        const handle=await fs.promises.open('/app/input.txt','r');
        let handleStat;
        try{handleStat=await handle.stat({bigint:true})}finally{await handle.close()}
        wasi=new WASI({version:'preview1',fs,preopens:{'/app':'/app'}});
        const instance=new WebAssembly.Instance(reactor);wasi.initialize(instance);
        const errno=wasi.wasiImport.fd_filestat_get(3,64);
        const view=new DataView(instance.exports.memory.buffer);
        return {normal:typeof normal.size,big:typeof big.size,callback:typeof callback.size,
          handle:typeof handleStat.size,size:String(big.size),errno,type:view.getUint8(80)};
      }catch(error){return {error:{name:error.name,message:error.message}}}
      finally{
        if(wasi&&wasi.wasiImport.fd_close(3)!==0)throw Error('WASI descriptor cleanup failed');
        if(fd!==undefined)fs.closeSync(fd);
        setNativeSyncFileClient(undefined);session.close();
      }
    };`
  const result=await build({stdin:{contents:source,resolveDir:root,sourcefile:'compiler-stat-control.mjs'},
    platform:'browser',bundle:true,write:false,format:'esm',target:'es2022',
    alias:{'node:buffer':'buffer/','node:events':'events/','node:stream':'stream-browserify',
      'node:path':'path-browserify'}})
  const script=result.outputFiles[0].text
  const server=createServer((request,response)=>{
    const isScript=request.url==='/control.mjs'
    response.writeHead(200,{'Content-Type':isScript?'text/javascript':'text/html'})
    response.end(isScript?script:'<!doctype html><title>Compiler descriptor stat control</title>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin=`http://127.0.0.1:${server.address().port}`
  try{
    for(const engine of [chromium,firefox,webkit]){
      const browser=await engine.launch()
      try{
        const page=await browser.newPage()
        const errors=[];page.on('pageerror',error=>errors.push(error.message))
        await page.goto(origin)
        await page.addScriptTag({url:origin+'/control.mjs',type:'module'})
        for(const live of [false,true]){
          const row=await page.evaluate(live=>runStatControl(live),live)
          assert.deepEqual(row,{normal:'number',big:'bigint',callback:'bigint',handle:'bigint',
            size:'7',errno:0,type:3},`${engine.name()} ${live?'session':'local'}`)
          console.log(JSON.stringify({browser:engine.name(),version:browser.version(),live,...row}))
        }
        assert.deepEqual(errors,[])
      }finally{await browser.close()}
    }
    assert.deepEqual(identity(),before)
    console.log(JSON.stringify({diagnosticOnly:true,scriptSHA256:sha(script),inputs:before,inputsUnchanged:true}))
  }finally{await new Promise(resolve=>server.close(resolve))}
})
