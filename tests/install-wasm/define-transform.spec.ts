import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

const modes=process.env.DEFINE_TRANSFORM_MAP_MATRIX==='1'?['full','no-content','none']:['full']
const repeats=Number(process.env.DEFINE_TRANSFORM_REPEATS??3)
const profileJobs=process.env.DEFINE_TRANSFORM_PROFILE==='1'
if(!Number.isInteger(repeats)||repeats<3||repeats>10)throw Error('Expected 3 to 10 transform repetitions')
for(const mode of modes){
const captured=JSON.parse(readFileSync('tests/fixtures/sveltekit-define-transform.json','utf8'))
if(mode==='no-content'){
  captured.options.sourcesContent=false
  captured.expected.mapSHA256='459aab22a8eb528946fefb381c88fe7231f1d6a89f7166f0cda976cdab803958'
  captured.expected.mapBytes=13323
}else if(mode==='none'){
  captured.options.sourcemap=false
  captured.expected.mapSHA256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  captured.expected.mapBytes=0
}
const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/project/'+name,readFileSync('fixtures/install-sveltekit-wasm/'+name,'utf8')]))
files['/project/case.json']=JSON.stringify(captured)
files['/project/probe.mjs']=`
import {transform,stop,version} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const captured=JSON.parse(readFileSync('./case.json','utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
try{
  for(let index=0;index<${repeats};index++){
    const started=performance.now();
    const result=await transform(captured.source,captured.options);
    const ms=performance.now()-started;
    console.log(JSON.stringify({index,ms,version,codeSHA256:sha(result.code),mapSHA256:sha(result.map)}));
  }
}finally{stop()}
`

test('captured SvelteKit define transform matches native code and source map: '+mode,async({page,request},info)=>{
  if(process.env.TERMINATION_COOPERATIVE==='1'){
    const name='quickjs-als-asyncify-wasm-'+(process.env.COOPERATIVE_WASM_OPT??'o2')+'-generator-queue-yield-profile-poll4096-cooperative'+(process.env.COOPERATIVE_WASM_BATCH?'-batch'+process.env.COOPERATIVE_WASM_BATCH:'')+(process.env.COOPERATIVE_ASSIGNMENTS==='1'?'-assignments':'')+(process.env.COOPERATIVE_UNWIND==='1'?'-unwind':'')+(process.env.COOPERATIVE_HEAP_LOOPS==='1'?'-heap-loops':'')
    const metadata=JSON.parse(readFileSync('public/'+name+'/build.json','utf8'))
    const response=await request.get('/quickjs-als-asyncify-wasm-cooperative/engine.wasm')
    expect(response.ok()).toBe(true)
    expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(metadata.wasmSha256)
    await info.attach('define-transform-engine.json',{body:JSON.stringify(metadata),contentType:'application/json'})
  }
  await info.attach('define-transform-options.json',{body:JSON.stringify({mode,options:captured.options,expected:captured.expected}),contentType:'application/json'})
  await page.goto('/sandbox.html')
  const measured=await page.evaluate(async({files,profileJobs})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{cooperative:true,maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
    try{
      await kernel.install({cwd:'/project',ignoreScripts:true})
      const result=await kernel.runModule('/project/probe.mjs',{cwd:'/project',guestWasm:true,webAPIs:true,profileJobs,diagnostics:profileJobs,maxBytes:256*1024*1024,timeoutMs:30000})
      return {result,profile:kernel.jobProfile}
    }finally{kernel.close()}
  },{files,profileJobs})
  const {result}=measured
  await info.attach('define-transform-profile.json',{body:JSON.stringify(measured.profile),contentType:'application/json'})
  await info.attach('define-transform.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  const rows=result.stdout.trim().split('\n').map(line=>JSON.parse(line))
  expect(rows).toHaveLength(repeats)
  for(const row of rows){
    expect(row.version).toBe(captured.esbuildVersion)
    expect(row.codeSHA256).toBe(captured.expected.codeSHA256)
    expect(row.mapSHA256).toBe(captured.expected.mapSHA256)
  }
})
}
