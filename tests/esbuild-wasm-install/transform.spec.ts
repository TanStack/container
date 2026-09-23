import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'

const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/'+name,readFileSync('fixtures/install-esbuild-wasm/'+name,'utf8')]))
files['/start-transforms.json']=readFileSync('fixtures/start-compiler-transforms.json','utf8')
files['/mixed-service.mjs']=readFileSync('fixtures/esbuild-mixed-service.mjs','utf8')
const cooperative=process.env.COOPERATIVE_KERNEL==='1'
if(process.env.START_COMPILER_TRACE){
  const path=process.env.START_COMPILER_TRACE
  const events=execFileSync('unzip',['-p',path,'test.trace'],{encoding:'utf8'}).trim().split('\n').map(line=>JSON.parse(line))
  const capture=events.flatMap(event=>event.attachments??[]).find(item=>item.name==='compiler-transforms.json')
  if(!capture||!/^[a-f0-9]+$/.test(capture.sha1))throw Error('Missing compiler transform attachment')
  files['/start-transforms.json']=execFileSync('unzip',['-p',path,'resources/'+capture.sha1],{encoding:'utf8'})
}
test.beforeEach(async({context},info)=>{
  if(!cooperative)return
  const suffix=process.env.COOPERATIVE_GENERATOR_QUEUE==='1'?'-generator-queue':''
  for(const wasm of ['', '-wasm']){
    const base='quickjs-als-asyncify'+wasm
    await info.attach('engine'+wasm+'.json',{body:readFileSync('public/'+base+suffix+'-cooperative/build.json'),contentType:'application/json'})
    if(suffix)await context.route('**/'+base+'-cooperative/**',route=>route.continue({url:route.request().url().replace(base+'-cooperative/',base+suffix+'-cooperative/')}))
  }
  await info.attach('replayed-transforms.json',{body:files['/start-transforms.json'],contentType:'application/json'})
})

for(const scenario of ['single request','repeated concurrent requests','large concurrent requests','plugin builds and rebuilds','captured Start transforms','mixed service traffic'])test(`installed esbuild-wasm transforms TypeScript through its published Node API (${scenario})`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({files,scenario,cooperative})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{cooperative,maxBytes:256*1024*1024,workspace:{maxBytes:64*1024*1024}})
    let stage='install'
    try{
      const installation=await kernel.install({ignoreScripts:true})
      stage='transform'
      await kernel.writeText('/main.mjs',`
        import {transform,context,stop} from 'esbuild-wasm';
        import {readFileSync} from 'node:fs';
        try{
          ${scenario==='captured Start transforms'?`const captures=JSON.parse(readFileSync('/start-transforms.json','utf8'));for(let round=0;round<2;round++)for(const capture of captures){const started=performance.now();const result=await transform(capture.input,capture.options);console.log(JSON.stringify({round,file:capture.options.sourcefile,ms:performance.now()-started,bytes:result.code.length}));if(!result.code)throw Error('Empty captured transform')}`:''}
          ${scenario==='plugin builds and rebuilds'?`let revision=0;const ctx=await context({entryPoints:['entry'],bundle:true,write:false,format:'esm',plugins:[{name:'virtual-project',setup(build){build.onResolve({filter:/.*/},async args=>{await new Promise(resolve=>setTimeout(resolve,1));return {path:args.path,namespace:'virtual'}});build.onLoad({filter:/.*/,namespace:'virtual'},async args=>{await new Promise(resolve=>setTimeout(resolve,1));return {contents:args.path==='entry'?'import {value} from "dep";console.log(value)':'export const value: number = '+revision,loader:'ts'}})}}]});try{for(;revision<8;revision++){const result=await ctx.rebuild();if(!result.outputFiles[0].text.includes('console.log')||result.errors.length)throw Error('Incorrect plugin rebuild')}}finally{await ctx.dispose()}`:''}
          ${scenario==='repeated concurrent requests'?`for(let round=0;round<4;round++)await Promise.all(Array.from({length:8},async(_,i)=>{const result=await transform('export const value: number = '+(round*8+i),{loader:'ts',sourcemap:true});if(!result.code.includes('value')||result.warnings.length)throw Error('Incorrect concurrent transform')}));`:''}
          ${scenario==='large concurrent requests'?`const large=Array.from({length:1200},(_,i)=>'export const value'+i+' = (n: number) => ({n, label: "item'+i+'"});').join(String.fromCharCode(10));for(let round=0;round<3;round++)await Promise.all(Array.from({length:4},async()=>{const result=await transform(large,{loader:'ts',sourcemap:true});if(!result.code.includes('value1199')||result.warnings.length)throw Error('Incorrect large transform')}));`:''}
          const result=await transform('const answer: number = 42; console.log(answer)',{loader:'ts'});
          console.log(JSON.stringify({code:result.code,warnings:result.warnings}));
        }finally{stop()}
      `)
      const execution=await kernel.runModule(scenario==='mixed service traffic'?'/mixed-service.mjs':'/main.mjs',{guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:30000})
      return {stage,installation,execution}
    }catch(error){return {stage,error:String(error)}}finally{kernel.close()}
  },{files,scenario,cooperative})
  await info.attach('esbuild-wasm.json',{body:JSON.stringify(result),contentType:'application/json'})
  if(scenario==='captured Start transforms')console.log(JSON.stringify({browser:info.project.name,execution:result.execution}))
  expect(result.error,JSON.stringify(result)).toBeUndefined()
  expect(result.execution?.exitCode,result.execution?.stderr).toBe(0)
  const output=JSON.parse(result.execution!.stdout.trim().split('\n').at(-1)!)
  expect(output.code).toContain('42');expect(output.code).not.toContain(': number');expect(output.warnings).toEqual([])
  if(scenario==='mixed service traffic')expect(output.rounds).toBe(3)
})
