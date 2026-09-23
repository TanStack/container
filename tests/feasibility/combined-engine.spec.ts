import {test,expect} from '@playwright/test'

test('combined engine preserves the full native ALS corpus',async({page},info)=>{
  await page.goto('/sandbox.html')
  const report=await page.evaluate(()=>window.sandboxLab.runEngineALS(undefined,'quickjs-als-asyncify'))
  await info.attach('combined-als.json',{body:JSON.stringify(report),contentType:'application/json'})
  expect(report.results.length).toBe(34)
  for(const row of report.results)expect(row.status,`${row.id}: ${JSON.stringify(row.actual)}`).toBe('match')
})

test('native await, sync filesystem, async replies, and timers compose',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const w=new window.sandboxLab.Workspace({files:{
      '/value':'before',
      '/main.mjs':`import {AsyncLocalStorage} from 'node:async_hooks';
        import {readFileSync,writeFileSync} from 'node:fs';
        import {readFile} from 'node:fs/promises';
        const s=new AsyncLocalStorage();
        console.log('ready');
        const rows=await Promise.all(['a','b','c'].map(id=>s.run(id,async()=>{
          const pending=readFile('/value','utf8');
          const first=readFileSync('/value','utf8');
          await 0;
          writeFileSync('/'+id,s.getStore());
          const timer=await new Promise(resolve=>setTimeout(()=>resolve([s.getStore(),readFileSync('/'+id,'utf8')]),1));
          return [id,first,await pending,timer,s.getStore()];
        })));
        console.log(JSON.stringify({rows,outer:s.getStore()??null}));`,
    }})
    try{return await w.executeInVM('/main.mjs',{engine:'quickjs-als-asyncify',timeoutMs:10000,onOutput:(_,text)=>{
      if(text.includes('ready'))w.files.writeFile('/value',new TextEncoder().encode('host-edit'))
    }})}finally{w.close()}
  })
  await info.attach('combined-io.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toEqual({rows:['a','b','c'].map(id=>[id,'host-edit','host-edit',[id,id],id]),outer:null})
})

test('real browser-built Start returns complete overlapping SSR responses',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const build=await window.sandboxLab.buildStartFixtureInBrowser(undefined,'workerd')
    const w=new window.sandboxLab.Workspace({files:{
      '/start.mjs':build.code,
      '/main.mjs':`import server from './start.mjs';
        const results=await Promise.all(['/', '/about', '/?check=overlap'].map(async path=>{
          const response=await server.fetch(new Request('http://sandbox.local'+path));
          return {path,status:response.status,html:await response.text()};
        }));console.log(JSON.stringify(results));`,
    }})
    try{return {...await w.executeInVM('/main.mjs',{engine:'quickjs-als-asyncify',webAPIs:true,maxBytes:64*1024*1024,timeoutMs:30000}),bytes:build.code.length,packages:build.packageCount}}
    finally{w.close()}
  })
  await info.attach('combined-start.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  const rows=JSON.parse(result.stdout)
  expect(rows).toHaveLength(3)
  for(const row of rows){expect(row.status).toBe(200);expect(row.html).toContain('</html>')}
  expect(rows[0].html).toContain('Bare-bones Start')
  expect(rows[1].html).toContain('Second route')
})

test('guest Web APIs support streamed UTF-8 and cloned request bodies',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const w=new window.sandboxLab.Workspace({files:{'/main.mjs':`
      const bytes=new TextEncoder().encode('hello 🌎');const decoder=new TextDecoder();
      const text=decoder.decode(bytes.slice(0,8),{stream:true})+decoder.decode(bytes.slice(8));
      const stream=new ReadableStream({start(c){c.enqueue(bytes.slice(0,8));c.enqueue(bytes.slice(8));c.close()}});
      const request=new Request('https://sandbox.local/',{method:'POST',body:stream,headers:{'x-test':'ok'}});
      const copy=request.clone();const bodies=await Promise.all([request.text(),copy.text()]);
      let consumed=false;try{await request.text()}catch{consumed=true}
      console.log(JSON.stringify({text,bodies,consumed,header:copy.headers.get('x-test'),fetch:typeof fetch}));`}})
    try{return await w.executeInVM('/main.mjs',{engine:'quickjs-als-asyncify',webAPIs:true,maxBytes:32*1024*1024})}finally{w.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({text:'hello 🌎',bodies:['hello 🌎','hello 🌎'],consumed:true,header:'ok',fetch:'undefined'})
})

test('combined narrow-viewport action runs and downloads its report',async({page},info)=>{
  await page.setViewportSize({width:393,height:852})
  await page.goto('/sandbox.html')
  await page.getByRole('button',{name:'Test combined VM + Start',exact:true}).click()
  await expect(page.locator('#output')).toContainText('PASS: three overlapping Start requests',{timeout:120000})
  await expect(page.locator('#output')).toContainText('34/34 ALS cases matched Node.')
  await info.attach('combined-narrow-viewport.png',{body:await page.screenshot({fullPage:true}),contentType:'image/png'})
  const download=page.waitForEvent('download')
  await page.getByRole('link',{name:'Download combined report'}).click()
  expect((await download).suggestedFilename()).toBe('sandbox-combined-engine.json')
})

test('combined engine retains authority, cancellation, limits, and recovery',async({page},info)=>{
  await page.goto('/sandbox.html')
  const report=await page.evaluate(async()=>{
    const engine='quickjs-als-asyncify' as const
    const w=new window.sandboxLab.Workspace({files:{
      '/main.mjs':`import {AsyncLocalStorage} from 'node:async_hooks';import {readFileSync,writeFileSync} from 'node:fs';
        import {writeFile} from 'node:fs/promises';const s=new AsyncLocalStorage();
        const rows=await s.run('retained',async()=>{await 0;const errors=[];
          for(const call of [()=>readFileSync('/missing'),()=>writeFileSync('/denied','no'),()=>writeFile('/denied','no')]){
            try{await call()}catch(e){errors.push([e.message,s.getStore()])}
          }return errors});
        let canceled=true;const id=setTimeout(()=>{canceled=false},1);clearTimeout(id);
        await new Promise(r=>setTimeout(r,5));console.log(JSON.stringify({rows,canceled,ambient:[typeof fetch,typeof document,typeof __qjsGetAsyncContext]}));`,
      '/loop.mjs':`import {readFileSync} from 'node:fs'; await 0;readFileSync('/value');for(;;){}`,
      '/heap.mjs':`import {readFileSync} from 'node:fs'; await 0;readFileSync('/value');new Uint8Array(2*1024*1024);`,
      '/ok.mjs':`import {readFileSync} from 'node:fs';await 0;console.log(readFileSync('/value','utf8'));`,
      '/cancel.mjs':`import {readFileSync} from 'node:fs';await 0;console.log('cancel-now');readFileSync('/value');`,
      '/value':'recovered',
    }})
    try{
      const authority=await w.executeInVM('/main.mjs',{engine,writable:false})
      const denied=await w.files.exists('/denied')
      const loop=await w.executeInVM('/loop.mjs',{engine,timeoutMs:100})
      const heap=await w.executeInVM('/heap.mjs',{engine,maxBytes:1024*1024})
      const recovery=await w.executeInVM('/ok.mjs',{engine})
      const cancel=await w.executeInVM('/cancel.mjs',{engine,onOutput:()=>w.close()})
      return {authority,denied,loop,heap,recovery,cancel}
    }finally{w.close()}
  })
  await info.attach('combined-limits.json',{body:JSON.stringify(report),contentType:'application/json'})
  expect(report.authority.exitCode,report.authority.stderr).toBe(0)
  const value=JSON.parse(report.authority.stdout)
  expect(value.rows).toHaveLength(3)
  expect(value.rows.every((x:string[])=>x[1]==='retained')).toBe(true)
  expect(value.rows[0][0]).toMatch(/ENOENT|not found|does not exist/i)
  expect(value.rows.slice(1).every((x:string[])=>x[0].includes('read-only'))).toBe(true)
  expect(value.canceled).toBe(true)
  expect(value.ambient).toEqual(['undefined','undefined','undefined'])
  expect(report.denied).toBe(false)
  expect(report.loop.exitCode).toBe(1)
  expect(report.loop.stderr).toMatch(/interrupt|timed out/i)
  expect(report.heap.exitCode).toBe(1)
  expect(report.heap.stderr).toMatch(/memory/i)
  expect(report.recovery.exitCode).toBe(0)
  expect(report.recovery.stdout.trim()).toBe('recovered')
  expect(report.cancel.exitCode).toBe(1)
  expect(report.cancel.stderr).toContain('Workspace closed')
})
