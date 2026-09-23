import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const fixtureProfile=process.env.VUE_SSR_FIXTURE??'dedicated'
if(!['dedicated','shared'].includes(fixtureProfile))throw Error('VUE_SSR_FIXTURE must be dedicated or shared')
const fixture=resolve(fixtureProfile==='shared'?'fixtures/workloads':'fixtures/install-vue-ssr')
const counterComponent=`({setup(){const count=ref(42);return()=>h('button',{id:'counter',onClick:()=>count.value++},String(count.value))}})`
let server,url,snapshot,preparation
test.beforeAll(async()=>{
  const closure=await collectInstalledClosure(fixture,['vue','@vue/server-renderer'])
  preparation={...closure.preparation,bytes:Object.values(closure.files).reduce((sum,file)=>sum+Buffer.from(file.base64,'base64').length,0),files:Object.keys(closure.files).length}
  snapshot=JSON.stringify(closure)
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="importmap">{"imports":{"vue":"/vue-runtime.mjs"}}</script><script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
    if(path==='/vue-runtime.mjs'){res.setHeader('content-type','text/javascript');res.end(readFileSync(resolve(fixture,'node_modules/vue/dist/vue.runtime.esm-browser.prod.js')));return}
    if(path==='/counter.mjs'){res.setHeader('content-type','text/javascript');res.end(`import {createSSRApp,h,ref} from '/vue-runtime.mjs';export function hydrate(element){const app=createSSRApp(${counterComponent});app.mount(element);return app}`);return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

async function runGuest(page,source){
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  return page.evaluate(async source=>{
    const snapshot=await fetch('/fixture.json').then(r=>r.json())
    const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
    files['/project/main.cjs']=source
    let kernel
    try{kernel=new window.sdk.WorkerKernel(files,{experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000});return {result:await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:128*1024*1024,timeoutMs:15000})}}
    catch(error){return {error:{name:error.name,message:error.message}}}
    finally{kernel?.close()}
  },source)
}

const source=`const {createSSRApp,defineComponent,h,computed,ref}=require('vue');
const {renderToString,renderToNodeStream}=require('@vue/server-renderer');
const {AsyncLocalStorage}=require('node:async_hooks');const als=new AsyncLocalStorage();
const Component=defineComponent({async setup(){
 const before=als.getStore();await new Promise(resolve=>setTimeout(resolve,before==='first'?2:1));
 const after=als.getStore(),answer=computed(()=>21*2);
 return ()=>h('section',{'data-request':after},[h('h1',before),h('p','<safe>&'),h('output',String(answer.value))]);
}});
async function render(request,streamed){return als.run(request,async()=>{
 const app=createSSRApp(Component);let html='';
 if(streamed){for await(const chunk of renderToNodeStream(app))html+=chunk.toString()}else html=await renderToString(app);
 return {request,html,contextAfter:als.getStore()};
})}
Promise.all([render('first',false),render('second',false),render('streamed',true)]).then(async results=>console.log(JSON.stringify({results,outside:als.getStore()??null,hydrationHtml:await renderToString(createSSRApp(${counterComponent}))}))).catch(error=>{console.error(error.stack);process.exitCode=1});`

test('Vue concurrent async SSR and Node stream preserve request context and native HTML',async({page},info)=>{
  const native=spawnSync(process.execPath,['-e',source],{cwd:fixture,encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout)
  expect(expected.outside).toBeNull()
  for(const row of expected.results){expect(row.contextAfter).toBe(row.request);expect(row.html).toContain('data-request="'+row.request+'"');expect(row.html).toContain('&lt;safe&gt;&amp;');expect(row.html).toContain('<output>42</output>')}
  const observed=await runGuest(page,source)
  const path=info.outputPath('vue-ssr.json')
  await writeFile(path,JSON.stringify({sdk:root,fixtureProfile,fixture,preparation,version:JSON.parse(readFileSync(resolve(fixture,'node_modules/vue/package.json'),'utf8')).version,native:{status:native.status,stdout:native.stdout,stderr:native.stderr},observed},null,2))
  await info.attach('vue-ssr.json',{path,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr).toBe(0)
  expect(JSON.parse(observed.result.stdout)).toEqual(expected)
  const browserErrors=[]
  page.on('pageerror',error=>browserErrors.push(error.message))
  page.on('console',message=>{if(message.type()==='error'||message.type()==='warning')browserErrors.push(message.text())})
  const hydration=await page.evaluate(async html=>{
    const element=document.createElement('div');element.id='vue-preview';element.innerHTML=html;document.body.append(element)
    const original=element.querySelector('#counter')
    const {hydrate}=await import('/counter.mjs');window.vueFixtureApp=hydrate(element)
    return {sameNode:original===element.querySelector('#counter'),text:element.textContent}
  },JSON.parse(observed.result.stdout).hydrationHtml)
  expect(hydration).toEqual({sameNode:true,text:'42'})
  await page.locator('#counter').click();await expect(page.locator('#counter')).toHaveText('43')
  const updatedText=await page.locator('#counter').textContent()
  await page.evaluate(()=>{window.vueFixtureApp.unmount();delete window.vueFixtureApp})
  await expect(page.locator('#counter')).toHaveCount(0)
  const hydrationPath=info.outputPath('vue-hydration.json')
  await writeFile(hydrationPath,JSON.stringify({sdk:root,hydration,updatedText,browserErrors,clientRuntime:'Pinned Vue prebuilt browser runtime, not a guest Vite build'},null,2))
  await info.attach('vue-hydration.json',{path:hydrationPath,contentType:'application/json'})
  expect(browserErrors).toEqual([])
})

test('Vue SFC compiler emits native-matched client modules for edit and remount',async({page},info)=>{
  const inputs=[42,7].map(initial=>`<script setup>import {ref} from 'vue';const count=ref(${initial});</script><template><button id="sfc-counter" @click="count++">{{ count }}</button></template>`)
  const source=`const {parse,compileScript}=require('@vue/compiler-sfc');const outputs=${JSON.stringify(inputs)}.map(input=>{const {descriptor,errors}=parse(input,{filename:'Counter.vue'});if(errors.length)throw errors[0];const result=compileScript(descriptor,{id:'counter-fixture',inlineTemplate:true});return {code:result.content,bindings:result.bindings}});console.log(JSON.stringify(outputs));`
  const native=spawnSync(process.execPath,['-e',source],{cwd:fixture,encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const observed=await runGuest(page,source)
  const path=info.outputPath('vue-sfc-compile.json')
  await writeFile(path,JSON.stringify({sdk:root,fixtureProfile,preparation,native:{status:native.status,stdout:native.stdout,stderr:native.stderr},observed},null,2))
  await info.attach('vue-sfc-compile.json',{path,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr).toBe(0)
  const outputs=JSON.parse(observed.result.stdout)
  expect(outputs).toEqual(JSON.parse(native.stdout))
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  for(const [index,output] of outputs.entries()){
    await page.evaluate(async code=>{
      window.sfcApp?.unmount()
      const root=document.querySelector('#sfc-root')??document.body.appendChild(Object.assign(document.createElement('div'),{id:'sfc-root'}))
      const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}))
      try{const [{createApp},{default:component}]=await Promise.all([import('vue'),import(url)]);window.sfcApp=createApp(component);window.sfcApp.mount(root)}finally{URL.revokeObjectURL(url)}
    },output.code)
    const initial=index===0?42:7
    await expect(page.locator('#sfc-counter')).toHaveText(String(initial))
    await page.locator('#sfc-counter').click()
    await expect(page.locator('#sfc-counter')).toHaveText(String(initial+1))
  }
  await page.evaluate(()=>{window.sfcApp.unmount();delete window.sfcApp})
  await expect(page.locator('#sfc-counter')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Vue compiler reports source locations and recovers for scoped CSS compilation',async({page},info)=>{
  const input='<template>\n  <div>broken\n</template>'
  const css='.counter { color: rgb(10, 20, 30); animation: pulse 1s; } @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }'
  const source=`const {parse,compileScript,compileStyle}=require('@vue/compiler-sfc');
const invalid=parse(${JSON.stringify(input)},{filename:'Broken.vue'});
const errors=invalid.errors.map(error=>({name:error.name,code:error.code,message:error.message,location:error.loc}));
const {descriptor,errors:validErrors}=parse('<script setup>const answer=42;</script><template><output>{{ answer }}</output></template>',{filename:'Fixed.vue'});
if(validErrors.length)throw validErrors[0];const script=compileScript(descriptor,{id:'recovery',inlineTemplate:true});
const style=compileStyle({source:${JSON.stringify(css)},filename:'Fixed.vue',id:'data-v-recovery',scoped:true});
if(style.errors.length)throw style.errors[0];console.log(JSON.stringify({errors,recovered:script.content.includes('42'),bindings:script.bindings,css:style.code}));`
  const native=spawnSync(process.execPath,['-e',source],{cwd:fixture,encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout)
  expect(expected.errors).toHaveLength(1)
  expect(expected.errors[0]).toMatchObject({name:'SyntaxError',location:{start:{line:2,column:3}}})
  expect(expected.recovered).toBe(true)
  expect(expected.css).toContain('.counter[data-v-recovery]')
  expect(expected.css).toContain('@keyframes pulse-recovery')
  const observed=await runGuest(page,source)
  const path=info.outputPath('vue-compiler-recovery.json')
  await writeFile(path,JSON.stringify({sdk:root,fixtureProfile,native:{status:native.status,stdout:native.stdout,stderr:native.stderr},observed},null,2))
  await info.attach('vue-compiler-recovery.json',{path,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr).toBe(0)
  expect(JSON.parse(observed.result.stdout)).toEqual(expected)
})
