import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/project/'+name,readFileSync('fixtures/install-sveltekit-wasm/'+name,'utf8')]))
files['/project/input.js']=readFileSync('tests/fixtures/sveltekit-respond-transformed.js','utf8')
const depth=process.env.ROLLUP_PARSE_DEPTH
if(depth!==undefined){
  if(!/^\d+$/.test(depth)||Number(depth)>128)throw Error('Invalid parser probe depth')
  files['/project/input.js']='export function probe(x){'+'if(x){'.repeat(Number(depth))+'return x;'+'}'.repeat(Number(depth))+'}'
}
files['/project/probe.mjs']=`import fs from 'node:fs';import {parseAsync} from './node_modules/rollup/dist/native.js';
console.log('parser loaded');const input=fs.readFileSync('./input.js','utf8');
try{const ast=await parseAsync(input,false,false);console.log('parsed '+ast.length)}catch(error){
  const recovered=await parseAsync('export const recovered=42',false,false);console.log('recovered '+recovered.length);throw error;
}`
test(`Rollup WASM parses ${depth===undefined?'the captured SvelteKit server module':depth+' nested conditionals'} in isolation`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{cooperative:true,maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
    try{
      await kernel.install({cwd:'/project',ignoreScripts:true})
      return await kernel.runModule('/project/probe.mjs',{cwd:'/project',guestWasm:true,webAPIs:true,timeoutMs:30000,maxBytes:256*1024*1024})
    }finally{kernel.close()}
  },files)
  await info.attach('isolated-rollup.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toMatch(/parsed \d+/)
})
