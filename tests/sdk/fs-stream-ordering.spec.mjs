import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync,mkdtempSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'

const root=realpathSync(process.env.SDK_OUTPUT)
let server,url
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})
const cases=[
  {name:'mkdtemp sync callback and promises preserve paths modes and task ordering',code:`(async()=>{const {pathToFileURL}=require('node:url'),events=[];const describe=(value,prefix)=>{const text=Buffer.isBuffer(value)?value.toString():value;return {buffer:Buffer.isBuffer(value),prefix:text.startsWith(prefix),suffix:/^[A-Za-z0-9]{6}$/.test(text.slice(prefix.length)),directory:fs.statSync(value).isDirectory(),mode:fs.statSync(value).mode&511}};const sync=fs.mkdtempSync('sync-'),input=Buffer.from('callback-');const pending=new Promise((resolve,reject)=>fs.mkdtemp(input,{encoding:'buffer'},(error,value)=>{events.push('callback');error?reject(error):resolve(value)}));input.fill(120);queueMicrotask(()=>events.push('microtask'));const callback=await pending,prefix=process.cwd()+'/promise-',promise=await fs.promises.mkdtemp(pathToFileURL(prefix));let invalid,missing;try{fs.mkdtemp({},()=>{})}catch(error){invalid=error.code}try{await fs.promises.mkdtemp('missing/child-')}catch(error){missing=error.code}return {sync:describe(sync,'sync-'),callback:describe(callback,'callback-'),promise:describe(promise,prefix),events,invalid,missing}})().then(value=>console.log(JSON.stringify(value)),error=>{console.error(error);process.exitCode=1});`},
  {name:'FileHandle writeFile respects offset and keeps writes alive through close',code:`(async()=>{const handle=await fs.promises.open('write-file','w+');await handle.write(Buffer.from('ab'));await handle.writeFile('cdef');await handle.writeFile(new Uint8Array([103,104]));const pending=handle.writeFile(Buffer.from('ij')),close=handle.close();const result=await pending;await close;return {text:fs.readFileSync('write-file','utf8'),undefinedResult:result===undefined,fd:handle.fd}})().then(value=>console.log(JSON.stringify(value)),error=>{console.error(error);process.exitCode=1});`},
  {name:'FileHandle vector captures views before its task boundary',code:`(async()=>{const handle=await fs.promises.open('admission','w+');try{const buffers=[Buffer.from('ab')],pending=handle.writev(buffers);buffers[0]=Buffer.from('XY');const result=await pending;const original=Buffer.alloc(2),readBuffers=[original],read=handle.readv(readBuffers,0);readBuffers[0]=Buffer.alloc(2,90);const readResult=await read;return {text:original.toString(),replacement:readBuffers[0].toString(),written:result.bytesWritten,read:readResult.bytesRead,writeIdentity:result.buffers===buffers,readIdentity:readResult.buffers===readBuffers}}finally{await handle.close()}})().then(value=>console.log(JSON.stringify(value)),error=>{console.error(error);process.exitCode=1});`},
  {name:'sync callback and promisified vector IO preserve results and ordering',code:`(async()=>{const {promisify}=require('node:util'),fd=fs.openSync('vector','w+'),events=[];try{const sync=fs.writevSync(fd,[Buffer.from('ab'),Buffer.from('cd')]);const buffers=[Buffer.from('X'),Buffer.from('Y')];const pending=new Promise((resolve,reject)=>fs.writev(fd,buffers,1,(error,count,returned)=>{events.push('callback');error?reject(error):resolve({count,identity:returned===buffers})}));queueMicrotask(()=>events.push('microtask'));const callback=await pending,readBuffers=[Buffer.alloc(2),Buffer.alloc(3)],read=await promisify(fs.readv)(fd,readBuffers,0),written=await promisify(fs.writev)(fd,[Buffer.from('!')]);const final=[Buffer.alloc(5)],size=fs.readvSync(fd,final,0);let invalid;try{fs.writev(fd,[Buffer.from('Q'),{}],()=>{})}catch(error){invalid=error.code}return {sync,callback,events,read:read.bytesRead,identity:read.buffers===readBuffers,text:Buffer.concat(readBuffers).subarray(0,read.bytesRead).toString(),written:written.bytesWritten,size,final:final[0].toString(),invalid}}finally{fs.closeSync(fd)}})().then(value=>console.log(JSON.stringify(value)),error=>{console.error(error);process.exitCode=1});`},
  {name:'FileHandle vector IO distinguishes explicit and implicit offsets',code:`(async()=>{const handle=await fs.promises.open('vector','w+');try{const buffers=[Buffer.from('ab'),Buffer.from('cd')],first=await handle.writev(buffers),explicit=await handle.writev([Buffer.from('X'),Buffer.from('Y')],1),implicit=await handle.writev([Buffer.from('ef')]);const readBuffers=[Buffer.alloc(2),Buffer.alloc(4)],read=await handle.readv(readBuffers,0),tailBuffers=[Buffer.alloc(1)],tail=await handle.readv(tailBuffers);return {written:[first.bytesWritten,explicit.bytesWritten,implicit.bytesWritten],read:read.bytesRead,text:Buffer.concat(readBuffers).toString(),tail:tail.bytesRead,writeIdentity:first.buffers===buffers,readIdentity:read.buffers===readBuffers}}finally{await handle.close()}})().then(value=>console.log(JSON.stringify(value)),error=>{console.error(error);process.exitCode=1});`},
  {name:'ReadStream bounded range preserves caller-owned descriptor',code:`const fd=fs.openSync('value','r'),chunks=[],stream=fs.createReadStream(null,{fd,autoClose:false,start:1,end:3,highWaterMark:2});stream.on('data',chunk=>chunks.push(chunk));stream.on('error',error=>{console.error(error);process.exitCode=1});stream.on('end',()=>{const text=Buffer.concat(chunks).toString(),stillOpen=fs.fstatSync(fd).isFile(),position=Buffer.alloc(1);fs.readSync(fd,position,0,1,null);fs.closeSync(fd);console.log(JSON.stringify({text,bytesRead:stream.bytesRead,stillOpen,position:position.toString()}))});`},
  {name:'ReadStream open and ready follow current microtasks',code:`const events=[],stream=fs.createReadStream('value');stream.on('open',()=>events.push('open'));stream.on('ready',()=>events.push('ready'));stream.on('error',error=>events.push(error.code));stream.on('close',()=>console.log(JSON.stringify(events)));queueMicrotask(()=>events.push('microtask'));stream.resume();`},
  {name:'WriteStream open and ready follow current microtasks',code:`const events=[],stream=fs.createWriteStream('output');stream.on('open',()=>events.push('open'));stream.on('ready',()=>events.push('ready'));stream.on('error',error=>events.push(error.code));stream.on('close',()=>console.log(JSON.stringify(events)));queueMicrotask(()=>events.push('microtask'));stream.end('alpha');`},
  {name:'ReadStream destroy waits for an admitted read',code:`const errors=[],stream=fs.createReadStream('value',{highWaterMark:5}),originalRead=stream._read;let started=false;stream._read=function(size){started=true;originalRead.call(this,size);queueMicrotask(()=>this.destroy())};stream.on('error',error=>errors.push(error.code));stream.on('close',()=>console.log(JSON.stringify({started,errors,bytesRead:stream.bytesRead,fd:stream.fd,closed:stream.closed})));stream.resume();`},
]
for(const sample of cases)test(`packaged filesystem stream ordering: ${sample.name}`,async({page},info)=>{
  test.setTimeout(60000)
  const source=`const fs=require('node:fs');fs.writeFileSync('value','alpha');${sample.code}`
  const nativeDirectory=mkdtempSync(join(tmpdir(),'fs-stream-ordering-'))
  const native=spawnSync(process.execPath,['-e',source],{cwd:nativeDirectory,encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  const expected=JSON.parse(native.stdout.trim())
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async source=>{
    const kernel=new window.sdk.WorkerKernel({'/project/main.cjs':source},{experimentalFibers:true,maxBytes:64*1024*1024,timeoutMs:15000})
    try{return await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:64*1024*1024,timeoutMs:15000})}
    finally{kernel.close()}
  },source)
  const path=info.outputPath('fs-stream-ordering.json')
  await writeFile(path,JSON.stringify({sdk:root,sample:sample.name,nativeDirectory,native:expected,observed},null,2))
  await info.attach('fs-stream-ordering.json',{path,contentType:'application/json'})
  expect(observed.exitCode,observed.stderr).toBe(0)
  expect(JSON.parse(observed.stdout.trim())).toEqual(expected)
})
