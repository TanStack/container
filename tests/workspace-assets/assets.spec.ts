import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

test('binary workspace fetch loads a module-relative WASM asset with ALS and no network',async({page},info)=>{
  const bytes=[...readFileSync('public/wasm-interpreter-probe/controls.wasm')]
  const external:string[]=[]
  await page.route('**/*',route=>{
    if(new URL(route.request().url()).hostname!=='127.0.0.1'){external.push(route.request().url());return route.abort()}
    return route.continue()
  })
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async bytes=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/lib/a b.wasm':new Uint8Array(bytes),'/lib/main.mjs':`
      import {AsyncLocalStorage} from 'node:async_hooks';
      const als=new AsyncLocalStorage();
      await als.run('asset',async()=>{
        const response=await fetch(new URL('./a%20b.wasm?version=1#ignored',import.meta.url));
        const copy=response.clone();
        const {instance}=await WebAssembly.instantiate(await response.arrayBuffer());
        const same=await copy.arrayBuffer();
        console.log(instance.exports.answer(),response.status,response.headers.get('content-type'),same.byteLength,als.getStore(),response.bodyUsed,response.url);
      });
      const head=await fetch('https://workspace.invalid/lib/a%20b.wasm',{method:'HEAD'});
      console.log(head.status,head.body,head.headers.get('content-length'),typeof __readWorkspaceAsset,typeof document);
      const missing=await fetch('file:///missing');console.log(missing.status,missing.ok,await missing.text());
      try{await fetch('https://example.com/private')}catch(e){console.log(e.name)}
    `})
    try{return await kernel.runModule('/lib/main.mjs',{guestWasm:true,webAPIs:true,workspaceFetch:true,maxBytes:64*1024*1024})}finally{kernel.close()}
  },bytes)
  await info.attach('asset-result.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(`42 200 application/wasm ${bytes.length} asset true file:///lib/a%20b.wasm?version=1\n200 null ${bytes.length} undefined undefined\n404 false \nTypeError\n`)
  expect(external).toEqual([])
})

test('abort before read, during body consumption, clone cancellation and repeated reads',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/data':new Uint8Array(200000).fill(42)})
    try{return await kernel.execute(`
      const a=new AbortController(),reason={cancelled:true};a.abort(reason);
      try{await fetch('file:///data',{signal:a.signal})}catch(e){console.log('before',e===reason)}
      const b=new AbortController(),pending=fetch('file:///data',{signal:b.signal});b.abort(reason);
      try{await pending}catch(e){console.log('pending',e===reason)}
      const c=new AbortController(),response=await fetch('file:///data',{signal:c.signal});
      const reader=response.body.getReader(),first=await reader.read();
      console.log(first.value.length,first.value[0]);c.abort(reason);
      try{await reader.read()}catch(e){console.log('body',e===reason)}
      const next=await fetch('file:///data'),clone=next.clone();
      const cancellation=next.body.cancel();
      console.log('clone',(await clone.arrayBuffer()).byteLength);await cancellation;
      for(let i=0;i<20;i++){const r=await fetch('file:///data');if((await r.arrayBuffer()).byteLength!==200000)throw Error('length')}
      console.log('repeated',20);
    `,{webAPIs:true,workspaceFetch:true,guestWasm:true,maxBytes:64*1024*1024})}finally{kernel.close()}
  })
  await info.attach('abort-result.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('before true\npending true\n65536 42\nbody true\nclone 200000\nrepeated 20\n')
})

test('workspace reads are opt-in, quotas fail closed, and fresh executions recover',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/data':'ok'})
    try{
      const disabled=await kernel.execute('console.log(typeof fetch)',{webAPIs:true,guestWasm:true})
      const quota=await kernel.execute(`for(let i=0;i<128;i++)await fetch('file:///data',{method:'HEAD'});
        try{await fetch('file:///data')}catch(e){console.log(e.code)}
        try{await fetch('file:///data')}catch(e){console.log(e.code)}`,{webAPIs:true,workspaceFetch:true,guestWasm:true})
      const recovery=await kernel.execute(`console.log(await (await fetch('file:///data')).text())`,{webAPIs:true,workspaceFetch:true,guestWasm:true})
      return {disabled,quota,recovery}
    }finally{kernel.close()}
  })
  await info.attach('quota-result.json',{body:JSON.stringify(result),contentType:'application/json'})
  for(const item of Object.values(result))expect(item.exitCode,item.stderr).toBe(0)
  expect(result.disabled.stdout).toBe('undefined\n')
  expect(result.quota.stdout).toBe('ERR_RESOURCE_LIMIT\nERR_RESOURCE_LIMIT\n')
  expect(result.recovery.stdout).toBe('ok\n')
})

test('external fetch is exact-origin opt-in with method and byte quotas',async({page},info)=>{
  const requests:string[]=[]
  await page.route('https://api.example.test/**',async route=>{
    requests.push(route.request().url())
    const path=new URL(route.request().url()).pathname
    if(path==='/large')return route.fulfill({status:200,headers:{'access-control-allow-origin':'*','content-type':'text/plain'},body:'x'.repeat(33)})
    return route.fulfill({status:200,headers:{'access-control-allow-origin':'*','content-type':'application/json','x-test':'allowed'},body:JSON.stringify({answer:42})})
  })
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    const options={webAPIs:true,externalFetch:{allowedOrigins:['https://api.example.test'],maxRequests:2,maxResponseBytes:32,maxTotalBytes:32},guestWasm:true,maxBytes:64*1024*1024,timeoutMs:10000}
    try{
      const allowed=await kernel.execute(`
        const response=await fetch('https://api.example.test/value',{headers:{accept:'application/json'}});
        console.log(response.status,response.url,response.headers.get('content-type'),JSON.stringify(await response.json()));
        for(const [label,run] of [
          ['origin',()=>fetch('https://other.example.test/value')],
          ['method',()=>fetch('https://api.example.test/value',{method:'POST'})],
          ['header',()=>fetch('https://api.example.test/value',{headers:{authorization:'secret'}})],
          ['bytes',()=>fetch('https://api.example.test/large')],
        ])try{await run()}catch(error){console.log(label,error.code||error.name)}
      `,options)
      const disabled=await kernel.execute(`try{await fetch('https://api.example.test/value')}catch(error){console.log(error.name)}`,{webAPIs:true,guestWasm:true})
      return {allowed,disabled}
    }finally{kernel.close()}
  })
  await info.attach('external-fetch-result.json',{body:JSON.stringify({result,requests}),contentType:'application/json'})
  expect(result.allowed.exitCode,result.allowed.stderr).toBe(0)
  expect(result.allowed.stdout).toBe('200 https://api.example.test/value application/json {"answer":42}\norigin TypeError\nmethod TypeError\nheader TypeError\nbytes ERR_RESOURCE_LIMIT\n')
  expect(result.disabled.exitCode,result.disabled.stderr).toBe(0)
  expect(result.disabled.stdout).toBe('ReferenceError\n')
  expect(requests).toEqual(['https://api.example.test/value','https://api.example.test/large'])
})

for(const name of ['rollup','sqlite'])test(`${name} real package asset probe`,async({page},info)=>{
  const files:Record<string,string|number[]>=name==='rollup'?{
    '/package.json':'{"type":"module"}',
    '/rollup.js':readFileSync('fixtures/workloads/node_modules/@rollup/browser/dist/es/rollup.browser.js','utf8'),
    '/bindings_wasm_bg.wasm':[...readFileSync('fixtures/workloads/node_modules/@rollup/browser/dist/es/bindings_wasm_bg.wasm')],
    '/main.mjs':`const {rollup}=await import('./rollup.js');
      const bundle=await rollup({input:'main',plugins:[{name:'fixture',resolveId:id=>id,load:()=> 'globalThis.answer=42'}]});
      try{const out=await bundle.generate({format:'iife'});(0,eval)(out.output[0].code);console.log('answer',globalThis.answer)}finally{await bundle.close()}`,
  }:{
    '/sql-wasm.wasm':[...readFileSync('fixtures/workloads/node_modules/sql.js/dist/sql-wasm.wasm')],
    '/sql.cjs':readFileSync('fixtures/workloads/node_modules/sql.js/dist/sql-wasm.js','utf8'),
    '/main.mjs':`import init from './sql.cjs';
      const response=await fetch('https://workspace.invalid/sql-wasm.wasm');
      const wasmBinary=new Uint8Array(await response.arrayBuffer());console.log('asset',response.status,wasmBinary.length);
      const SQL=await init({wasmBinary});const db=new SQL.Database();
      try{db.run('CREATE TABLE values_table (value INTEGER)');db.run('INSERT INTO values_table VALUES (?)',[21]);console.log('answer',db.exec('SELECT value * 2 FROM values_table')[0].values[0][0])}finally{db.close()}`,
  }
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(Object.fromEntries(Object.entries(files).map(([path,data])=>[path,Array.isArray(data)?new Uint8Array(data):data])))
    const options={webAPIs:true,workspaceFetch:true,guestWasm:true,maxBytes:64*1024*1024,timeoutMs:10000}
    try{return await kernel.runModule('/main.mjs',options)}finally{kernel.close()}
  },files)
  const outcome={name,status:result.exitCode===0?'pass':'gap',adaptation:name==='sqlite'?'Official wasmBinary option with bytes fetched from virtual workspace':'Original ESM source and adjacent WASM asset mounted in virtual workspace',result}
  await info.attach('package-asset-probe.json',{body:JSON.stringify(outcome),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toContain('answer 42\n')
})

test('sqlite real package asset callbacks, transactions, export and reopen',async({page},info)=>{
  const files:Record<string,string|number[]>={
    '/sql-wasm.wasm':[...readFileSync('fixtures/workloads/node_modules/sql.js/dist/sql-wasm.wasm')],
    '/sql.cjs':readFileSync('fixtures/workloads/node_modules/sql.js/dist/sql-wasm.js','utf8'),
    '/main.mjs':`import init from './sql.cjs';
      const SQL=await init({wasmBinary:new Uint8Array(await (await fetch('https://workspace.invalid/sql-wasm.wasm')).arrayBuffer())});
      let db=new SQL.Database();const answers=[];let calls=0;
      try{
        db.run('CREATE TABLE items (value INTEGER, name TEXT, payload BLOB)');
        const stmt=db.prepare('INSERT INTO items VALUES (?, ?, ?)');
        try{stmt.run([21,'hello',new Uint8Array([0,128,255])])}finally{stmt.free()}
        for(const multiplier of [2,3,3,2]){
          db.create_function('scale',n=>{calls++;return n*multiplier});
          answers.push(db.exec('SELECT scale(value) FROM items')[0].values[0][0]);
        }
        db.run('BEGIN');db.run('INSERT INTO items VALUES (99, NULL, NULL)');db.run('ROLLBACK');
        let recovered=false;try{db.exec('SELECT missing FROM items')}catch{recovered=true}
        const saved=db.export();db.close();db=new SQL.Database(saved);
        const read=db.prepare('SELECT value, name, payload FROM items');let row;
        try{if(!read.step())throw Error('missing row');row=read.get();if(read.step())throw Error('rollback lost')}finally{read.free()}
        console.log(JSON.stringify({answers,calls,recovered,value:row[0],name:row[1],payload:[...row[2]],count:db.exec('SELECT COUNT(*) FROM items')[0].values[0][0]}));
      }finally{db.close()}`,
  }
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(Object.fromEntries(Object.entries(files).map(([path,data])=>[path,Array.isArray(data)?new Uint8Array(data):data])))
    try{return await kernel.runModule('/main.mjs',{webAPIs:true,workspaceFetch:true,guestWasm:true,maxBytes:64*1024*1024,timeoutMs:10000})}finally{kernel.close()}
  },files)
  await info.attach('package-asset-probe.json',{body:JSON.stringify({name:'sqlite-workflow',status:result.exitCode===0?'pass':'gap',result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({answers:[42,63,63,42],calls:4,recovered:true,value:21,name:'hello',payload:[0,128,255],count:1})
})

test('rollup real package asset edit, cache, plugins, source maps and error recovery',async({page},info)=>{
  const files:Record<string,string|number[]>={
    '/package.json':'{"type":"module"}',
    '/rollup.js':readFileSync('fixtures/workloads/node_modules/@rollup/browser/dist/es/rollup.browser.js','utf8'),
    '/bindings_wasm_bg.wasm':[...readFileSync('fixtures/workloads/node_modules/@rollup/browser/dist/es/bindings_wasm_bg.wasm')],
    '/project/main.js':`import {twice} from './math.js';import value from './value.json';globalThis.answer=twice(value);`,
    '/project/value.json':'21',
    '/main.mjs':`
      import {readFileSync,writeFileSync} from 'node:fs';
      import {dirname,resolve} from 'node:path';
      import {rollup} from './rollup.js';
      let cache,closed=0;const rows=[],transformed=[];
      const plugin={name:'workspace',
        resolveId(id,importer){return resolve(importer?dirname(importer):'/project',id)},
        async load(id){await Promise.resolve();return readFileSync(id,'utf8')},
        async transform(code,id){
          await Promise.resolve();transformed.push(id);
          if(id.endsWith('.json'))return {code:'export default '+code,map:{mappings:''}};
          return null;
        },
        buildStart(){this.emitFile({type:'asset',fileName:'meta.txt',source:'guest plugin'})},
        closeBundle(){closed++}
      };
      async function build(){
        const start=Date.now();
        const bundle=await rollup({input:'/project/main.js',cache,plugins:[plugin]});
        try{
          const {output}=await bundle.generate({format:'iife',sourcemap:true});
          const chunk=output.find(item=>item.type==='chunk');
          if(!chunk.map||!chunk.map.mappings||!chunk.map.sources.some(id=>id.endsWith('math.js')))throw Error('Missing source map');
          if(!output.some(item=>item.type==='asset'&&item.fileName==='meta.txt'&&item.source==='guest plugin'))throw Error('Missing emitted asset');
          (0,eval)(chunk.code);cache=bundle.cache;
          return {answer:globalThis.answer,ms:Date.now()-start};
        }finally{await bundle.close()}
      }
      for(const multiplier of [2,3,3,2]){
        writeFileSync('/project/math.js','export const twice = n => n * '+multiplier+';');
        rows.push(await build());
      }
      writeFileSync('/project/math.js','export const twice = (');
      let errorCode;try{await build()}catch(error){errorCode=error.code}
      if(errorCode!=='PARSE_ERROR')throw Error('Expected a parse error, received '+errorCode);
      writeFileSync('/project/math.js','export const twice = n => n * 2;');
      const recovery=await build();
      console.log(JSON.stringify({rows,recovery,errorCode,closed,jsonPlugin:transformed.includes('/project/value.json')}));
    `,
  }
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(Object.fromEntries(Object.entries(files).map(([path,data])=>[path,Array.isArray(data)?new Uint8Array(data):data])))
    try{return await kernel.runModule('/main.mjs',{webAPIs:true,workspaceFetch:true,guestWasm:true,maxBytes:64*1024*1024,timeoutMs:10000})}finally{kernel.close()}
  },files)
  const details=result.exitCode===0?JSON.parse(result.stdout):undefined
  await info.attach('package-asset-probe.json',{body:JSON.stringify({name:'rollup-development',status:result.exitCode===0?'pass':'failure',adaptation:'Original ESM distribution and WASM asset mounted by host; project files, plugins, cache and all builds run inside guest',result,details}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(details.rows.map((row:{answer:number})=>row.answer)).toEqual([42,63,63,42])
  expect(details.recovery.answer).toBe(42)
  expect(details.errorCode).toBe('PARSE_ERROR')
  expect(details.jsonPlugin).toBe(true)
  expect(details.closed).toBeGreaterThanOrEqual(5)
})
