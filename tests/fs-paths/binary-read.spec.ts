import {test,expect} from '@playwright/test'

for(const guestWasm of [false,true])test(`${guestWasm?'WASM bridge':'default engine'}: large binary reads stay bounded and independent`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async guestWasm=>{
    const bytes=new Uint8Array(14*1024*1024);bytes[0]=137;bytes[1]=0;bytes[bytes.length-1]=255
    const kernel=new window.sandboxLab.WorkerKernel({'/binary':bytes,'/empty':new Uint8Array(),'/text':'hello','/main.mjs':`
      import fs from 'node:fs';import fsp from 'node:fs/promises';
      let first=fs.readFileSync('/binary');
      if(!Buffer.isBuffer(first)||first.length!==14*1024*1024||first[0]!==137||first[1]!==0||first.at(-1)!==255)throw Error('binary mismatch');
      first[0]=42;first=null;
      const second=await fsp.readFile('/binary');
      if(second[0]!==137)throw Error('guest mutation changed workspace');
      const empty=await new Promise((resolve,reject)=>fs.readFile('/empty',(error,value)=>error?reject(error):resolve(value)));
      if(!Buffer.isBuffer(empty)||empty.length!==0)throw Error('empty mismatch');
      if(fs.readFileSync('/text','utf8')!=='hello')throw Error('text mismatch');
      console.log('binary reads passed');
    `},{maxBytes:128*1024*1024})
    try{
      const execution=await kernel.runModule('/main.mjs',{guestWasm,maxBytes:128*1024*1024})
      const stored=await kernel.readFile('/binary')
      return {execution,first:stored[0],last:stored.at(-1)}
    }finally{kernel.close()}
  },guestWasm)
  await info.attach('binary-read.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.execution.exitCode,result.execution.stderr).toBe(0)
  expect(result.execution.stdout).toBe('binary reads passed\n')
  expect(result.first).toBe(137);expect(result.last).toBe(255)
})
