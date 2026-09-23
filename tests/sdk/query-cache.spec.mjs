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
  snapshot=JSON.stringify(await collectInstalledClosure(fixture,['@tanstack/query-core']))
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

test('packaged Query cache survives JSON hydration, retries and optimistic rollback with native parity',async({page},info)=>{
  const source=`const {QueryClient,dehydrate,hydrate}=require('@tanstack/query-core');
(async()=>{
 const defaults={queries:{gcTime:Infinity,staleTime:Infinity,retry:false},mutations:{gcTime:Infinity,retry:false}};
 const original=new QueryClient({defaultOptions:defaults}),restored=new QueryClient({defaultOptions:defaults});
 try{
  let initialCalls=0,restoredCalls=0,attempts=0;
  const key=['todo',{id:7}];
  await original.fetchQuery({queryKey:key,queryFn:async()=>{initialCalls++;return {id:7,title:'saved',done:false}}});
  const saved=JSON.parse(JSON.stringify(dehydrate(original)));
  hydrate(restored,saved);
  const cached=await restored.fetchQuery({queryKey:key,queryFn:async()=>{restoredCalls++;return {id:7,title:'unexpected'}}});
  const retried=await restored.fetchQuery({queryKey:['retry'],retry:1,retryDelay:0,queryFn:async()=>{attempts++;if(attempts===1)throw Error('temporary');return 42}});
  const events=[];
  const mutation=restored.getMutationCache().build(restored,{
   mutationKey:['rename'],
   onMutate:async title=>{const previous=restored.getQueryData(key);restored.setQueryData(key,{...previous,title});events.push('optimistic:'+restored.getQueryData(key).title);return {previous}},
   mutationFn:async()=>{throw Error('save rejected')},
   onError:async(error,_variables,context)=>{restored.setQueryData(key,context.previous);events.push('rollback:'+error.message)},
   onSettled:async()=>{events.push('settled')},
  });
  let rejected;try{await mutation.execute('edited')}catch(error){rejected=error.message}
  console.log(JSON.stringify({initialCalls,restoredCalls,cached,retried,attempts,persistedQueries:saved.queries.length,events,rejected,mutationStatus:mutation.state.status,final:restored.getQueryData(key)}));
 }finally{original.clear();restored.clear()}
})().catch(error=>{console.error(error.stack);process.exitCode=1});`
  const native=spawnSync(process.execPath,['-e',source],{cwd:fixture,encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout)
  expect(expected).toEqual({initialCalls:1,restoredCalls:0,cached:{id:7,title:'saved',done:false},retried:42,attempts:2,persistedQueries:1,events:['optimistic:edited','rollback:save rejected','settled'],rejected:'save rejected',mutationStatus:'error',final:{id:7,title:'saved',done:false}})
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const execution=await page.evaluate(async source=>{
    const evidence={result:null,error:null,closeError:null};let kernel
    try{
      const snapshot=await fetch('/fixture.json').then(r=>r.json())
      const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
      files['/project/main.cjs']=source
      kernel=new window.sdk.WorkerKernel(files,{experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000})
      evidence.result=await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:128*1024*1024,timeoutMs:15000})
    }catch(error){evidence.error={name:error.name,message:error.message,stack:error.stack}}
    finally{try{kernel?.close()}catch(error){evidence.closeError=String(error)}}
    return evidence
  },source)
  const path=info.outputPath('query-cache.json')
  await writeFile(path,JSON.stringify({sdk:root,version:JSON.parse(readFileSync(resolve(fixture,'node_modules/@tanstack/query-core/package.json'),'utf8')).version,native:{status:native.status,stdout:native.stdout,stderr:native.stderr},expected,...execution},null,2))
  await info.attach('query-cache.json',{path,contentType:'application/json'})
  expect(execution.error,JSON.stringify(execution)).toBeNull()
  expect(execution.closeError).toBeNull()
  expect(execution.result.exitCode,execution.result.stderr).toBe(0)
  expect(JSON.parse(execution.result.stdout)).toEqual(expected)
})
