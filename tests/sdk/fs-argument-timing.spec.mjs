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
const setup=`const fs=require('node:fs'),fsp=require('node:fs/promises');fs.mkdirSync('a');fs.mkdirSync('b');fs.writeFileSync('a/value','alpha');fs.writeFileSync('b/value','bravo');const summarize=result=>result.status==='fulfilled'?{status:result.status,value:result.value??null}:{status:result.status,code:result.reason.code};`;
const cases=[
  {name:'FileHandle close waits for multichunk read and accepts work while waiting',code:`fs.writeFileSync('a/large','x'.repeat(70000));const handle=await fsp.open('a/large');const read=handle.readFile('utf8').then(value=>value.length),close=handle.close(),again=handle.close(),late=handle.stat().then(value=>value.size);const outcomes=(await Promise.allSettled([read,close,again,late])).map(summarize);return {outcomes,afterClose:(await Promise.allSettled([handle.stat()])).map(summarize)};`},
  {name:'FileHandle close waits for truncate and write operations',code:`const handle=await fsp.open('a/value','r+');const write=handle.write(Buffer.from('omega'),0,5,0).then(value=>value.bytesWritten),truncate=handle.truncate(5),close=handle.close();const outcomes=(await Promise.allSettled([write,truncate,close])).map(summarize);return {outcomes,text:fs.readFileSync('a/value','utf8')};`},
  {name:'FileHandle readFile started before close completes',code:`const handle=await fsp.open('a/value');const read=handle.readFile('utf8'),close=handle.close();return (await Promise.allSettled([read,close])).map(summarize);`},
  {name:'FileHandle single read started before close completes',code:`const handle=await fsp.open('a/value'),buffer=Buffer.alloc(5);const read=handle.read(buffer).then(value=>({bytesRead:value.bytesRead,text:buffer.toString()})),close=handle.close();return (await Promise.allSettled([read,close])).map(summarize);`},
  {name:'FileHandle stat started before close completes',code:`const handle=await fsp.open('a/value');const stat=handle.stat().then(value=>value.size),close=handle.close();return (await Promise.allSettled([stat,close])).map(summarize);`},
  {name:'relative read submitted before chdir stays within either valid directory',nondeterministic:true,code:`const base=process.cwd(),values=[];for(let i=0;i<8;i++){process.chdir(base+'/a');const read=fsp.readFile('value','utf8');process.chdir(base+'/b');values.push(await read)}return values;`},
]
for(const sample of cases)test(`packaged filesystem argument timing: ${sample.name}`,async({page},info)=>{
  test.setTimeout(60000)
  const source=setup+`(async()=>{${sample.code}})().then(value=>console.log(JSON.stringify(value)),error=>{console.error(error);process.exitCode=1});`
  const nativeDirectory=mkdtempSync(join(tmpdir(),'fs-argument-parity-'))
  const native=spawnSync(process.execPath,['-e',source],{cwd:nativeDirectory,encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  const expected=JSON.parse(native.stdout.trim())
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async source=>{
    const kernel=new window.sdk.WorkerKernel({'/project/main.cjs':source},{experimentalFibers:true,maxBytes:64*1024*1024,timeoutMs:15000})
    try{return await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:64*1024*1024,timeoutMs:15000})}
    finally{kernel.close()}
  },source)
  const path=info.outputPath('fs-argument-timing.json')
  await writeFile(path,JSON.stringify({sdk:root,sample:sample.name,nativeDirectory,native:expected,observed},null,2))
  await info.attach('fs-argument-timing.json',{path,contentType:'application/json'})
  expect(observed.exitCode,observed.stderr).toBe(0)
  const actual=JSON.parse(observed.stdout.trim())
  if(sample.nondeterministic){for(const values of [expected,actual]){expect(values).toHaveLength(8);for(const value of values)expect(['alpha','bravo']).toContain(value)}}
  else expect(actual).toEqual(expected)
})
