import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT),fixture=resolve('fixtures/workloads')
let server,url,snapshot
test.beforeAll(async()=>{
  snapshot=JSON.stringify(await collectInstalledClosure(fixture,['postcss']))
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
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

for(const sample of [
  {name:'declarations',css:'.card { color: red; user-select: none; }'},
  {name:'nested-media',css:'/* fixture */\n@media (min-width: 600px) { .card { color: red; &:hover { color: red; } } }'},
])test(`packaged PostCSS processes ${sample.name} with native CSS and map parity`,async({page},info)=>{
  // An ordinary local plugin exercises the public traversal, mutation, cloning,
  // async processing, warnings and source-map paths, not third-party plugin coverage.
  const source=`const postcss=require('postcss');
const plugin={postcssPlugin:'fixture-colors',async Once(root,{result}){await Promise.resolve();root.walkDecls('color',decl=>{decl.value='blue'});root.walkDecls('user-select',decl=>{decl.cloneBefore({prop:'-webkit-user-select'})});result.warn('Processed fixture',{node:root.first});}};
postcss([plugin]).process(${JSON.stringify(sample.css)},{from:${JSON.stringify(sample.name+'.css')},to:${JSON.stringify(sample.name+'.out.css')},map:{inline:false,annotation:false,sourcesContent:true}}).then(result=>console.log(JSON.stringify({css:result.css,map:result.map.toJSON(),warnings:result.warnings().map(w=>({text:w.text,plugin:w.plugin,line:w.line,column:w.column}))}))).catch(error=>{console.error(error.stack);process.exit(1)});`
  const native=spawnSync(process.execPath,['-e',source],{cwd:fixture,encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native-postcss.json')
  await writeFile(nativePath,JSON.stringify({status:native.status,error:native.error?.message,stdout:native.stdout,stderr:native.stderr},null,2))
  await info.attach('native-postcss.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout)
  expect(expected.css).toContain('blue');expect(expected.css).not.toContain('color: red')
  expect(expected.map.sourcesContent).toEqual([sample.css]);expect(expected.map.mappings.length).toBeGreaterThan(0)
  expect(expected.warnings).toHaveLength(1)
  if(sample.name==='declarations')expect(expected.css).toContain('-webkit-user-select')
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const execution=await page.evaluate(async source=>{
    const evidence={result:null,error:null};let kernel
    try{
      const snapshot=await fetch('/fixture.json').then(r=>r.json())
      const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
      files['/project/main.cjs']=source
      kernel=new window.sdk.WorkerKernel(files,{experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000})
      evidence.result=await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:128*1024*1024,timeoutMs:15000})
    }catch(error){evidence.error={name:error.name,message:error.message,stack:error.stack}}
    finally{if(kernel)kernel.close()}
    return evidence
  },source)
  const evidencePath=info.outputPath('packaged-postcss.json')
  await writeFile(evidencePath,JSON.stringify({sdk:root,version:JSON.parse(readFileSync(resolve(fixture,'node_modules/postcss/package.json'),'utf8')).version,sample,expected,...execution},null,2))
  await info.attach('packaged-postcss.json',{path:evidencePath,contentType:'application/json'})
  expect(execution.error,JSON.stringify(execution)).toBeNull()
  expect(execution.result.exitCode,execution.result.stderr).toBe(0)
  expect(JSON.parse(execution.result.stdout)).toEqual(expected)
})
