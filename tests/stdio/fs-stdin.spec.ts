import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
const source=`
import fs from 'node:fs';import {promisify} from 'node:util';
const read=promisify(fs.read),out=[];
for(;;){const buffer=Buffer.alloc(4,99);const result=await read(0,buffer,1,2,null);out.push([result.bytesRead,[...buffer],result.buffer===buffer]);if(!result.bytesRead)break}
console.log(JSON.stringify(out));`
for(const guestWasm of [false,true])test(`filesystem stdin partial reads and EOF: ${guestWasm}`,async({page},info)=>{
  const input='abcdef',oracle=spawnSync(process.execPath,['--input-type=module','-e',source],{input,encoding:'utf8',timeout:10000})
  expect(oracle.status,oracle.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,input,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{const child=await kernel.spawn('node',['/main.mjs'],{guestWasm});await child.write(new TextEncoder().encode(input));await child.end();return await child.wait()}finally{kernel.close()}
  },{source,input,guestWasm})
  await info.attach('fs-stdin.json',{body:JSON.stringify({oracle:oracle.stdout,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(oracle.stdout)
})
test('completed filesystem stdin read does not retain process lifetime',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`import fs from 'node:fs';fs.read(0,Buffer.alloc(1),0,1,null,(e,n)=>{if(e)throw e;console.log(n)})`})
    try{const child=await kernel.spawn('node',['/main.mjs']);await child.write(new Uint8Array([42]));return await child.wait()}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe('1\n')
})
