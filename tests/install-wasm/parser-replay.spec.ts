import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'

const require=createRequire(import.meta.url)
const parser=require('@babel/parser')
const parserSource=readFileSync(require.resolve('@babel/parser'),'utf8')
const trace=process.env.PARSER_REPLAY_TRACE
let capture:{source:string;options:any}|undefined
if(trace){
  const read=(name:string)=>execFileSync('unzip',['-p',trace,name],{encoding:'utf8',maxBuffer:20*1024*1024})
  const events=read('test.trace').trim().split('\n').map(line=>JSON.parse(line))
  const attachment=events.flatMap(event=>event.attachments??[]).find(a=>a.name==='parser-failure.json')
  if(!attachment?.sha1)throw Error('Trace has no captured parser failure')
  capture=JSON.parse(read('resources/'+attachment.sha1))
  if(typeof capture?.source!=='string'||!capture.options)throw Error('Invalid parser capture')
}

for(const profileJobs of [false,true])test(`captured Babel input across microtasks, profiling=${profileJobs}`,async({page,context},info)=>{
  test.skip(!capture,'Set PARSER_REPLAY_TRACE to a captured Start failure')
  const reference=parser.parse(capture!.source,capture!.options).program.body.length
  const base='quickjs-als-asyncify-wasm'
  const suffix='-generator-queue-yield-profile-poll4096-cooperative'
  await context.route('**/'+base+'-cooperative/**',route=>route.continue({url:route.request().url().replace(base+'-cooperative/',base+suffix+'/')}))
  await info.attach('engine.json',{body:readFileSync('public/'+base+suffix+'/build.json'),contentType:'application/json'})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({parserSource,capture,profileJobs})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/parser.cjs':parserSource,'/capture.json':JSON.stringify(capture)},{cooperative:true,maxBytes:256*1024*1024})
    try{
      await kernel.writeText('/probe.mjs',`import parser from '/parser.cjs';import {readFileSync} from 'node:fs';const capture=JSON.parse(readFileSync('/capture.json','utf8'));const result=[];for(let i=0;i<8;i++){for(let j=0;j<25;j++)await Promise.resolve();try{result.push(parser.parse(capture.source,capture.options).program.body.length)}catch(error){result.push({name:error.name,message:error.message,stack:error.stack})}}console.log(JSON.stringify(result));`)
      return await kernel.runModule('/probe.mjs',{guestWasm:true,profileJobs,timeoutMs:30000,maxBytes:256*1024*1024})
    }finally{kernel.close()}
  },{parserSource,capture:capture!,profileJobs})
  await info.attach('replay.json',{body:JSON.stringify({inputSHA256:createHash('sha256').update(capture!.source).digest('hex'),reference,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).map((value:any)=>typeof value==='number'?value:{name:value.name,message:value.message})).toEqual(Array(8).fill(reference))
})
