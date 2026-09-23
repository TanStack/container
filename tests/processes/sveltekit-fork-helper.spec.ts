import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

const packageRoot='fixtures/workloads/node_modules/@sveltejs/kit'
const helper=readFileSync(packageRoot+'/src/utils/fork.js','utf8')
const manifest=readFileSync(packageRoot+'/package.json','utf8')
const helperSHA256=createHash('sha256').update(helper).digest('hex')
// The installed helper imports only node:url, node:worker_threads and
// node:process. No rewritten protocol or SvelteKit dependency stubs are used.
const files={
  '/node_modules/@sveltejs/kit/package.json':manifest,
  '/node_modules/@sveltejs/kit/src/utils/fork.js':helper,
  '/task.mjs':`import {forked} from './node_modules/@sveltejs/kit/src/utils/fork.js';
import {isMainThread,parentPort,threadId} from 'node:worker_threads';
import process from 'node:process';
export const run=forked(import.meta.url,async input=>{
  await Promise.resolve();
  // A normal lingering timer is why the real helper releases its worker.
  setInterval(()=>{},1000);
  return {answer:input.value+input.offset,label:input.label,fork:process.env.SVELTEKIT_FORK,
    inherited:process.env.FORK_HELPER_VALUE,isMainThread,hasParent:parentPort!==null,positiveThreadId:threadId>0};
});`,
  '/main.mjs':`import {run} from './task.mjs';import process from 'node:process';
process.env.FORK_HELPER_VALUE='inherited';
const first=await run({value:35,offset:7,label:'first'});
const second=await run({value:40,offset:2,label:'second'});
console.log(JSON.stringify({first,second,parentFork:process.env.SVELTEKIT_FORK??null}));`,
}

for(const guestWasm of [false,true])test(`installed SvelteKit forked helper executes a real child module ${guestWasm?'WASM':'default'}`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({files,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,timeoutMs:15000})}
    finally{kernel.close()}
  },{files,guestWasm})
  await info.attach('installed-sveltekit-fork-helper.json',{body:JSON.stringify({
    package:JSON.parse(manifest).name,version:JSON.parse(manifest).version,helperSHA256,
    source:'@sveltejs/kit/src/utils/fork.js',result,
  }),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  const common={answer:42,fork:'true',inherited:'inherited',isMainThread:false,hasParent:true,positiveThreadId:true}
  expect(JSON.parse(result.stdout)).toEqual({first:{...common,label:'first'},second:{...common,label:'second'},parentFork:null})
})
