import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const body=`
import fs from 'node:fs';import fsp from 'node:fs/promises';
const c=fs.constants,p=root+'/flags',out=[];
let fd=fs.openSync(p,c.O_WRONLY|c.O_CREAT|c.O_EXCL);fs.writeSync(fd,'abc');fs.closeSync(fd);
try{fs.openSync(p,c.O_WRONLY|c.O_CREAT|c.O_EXCL)}catch(e){out.push(e.code)}
fd=fs.openSync(p,c.O_RDWR);fs.writeSync(fd,'Z',1);fs.closeSync(fd);out.push(fs.readFileSync(p,'utf8'));
const h=await fsp.open(p,c.O_WRONLY|c.O_APPEND);await h.write('!');await h.close();out.push(fs.readFileSync(p,'utf8'));
fd=await new Promise((resolve,reject)=>fs.open(p,c.O_WRONLY|c.O_TRUNC,(e,fd)=>e?reject(e):resolve(fd)));fs.closeSync(fd);out.push(fs.readFileSync(p,'utf8'));
fd=fs.openSync(p,c.O_RDONLY);try{fs.writeSync(fd,'no')}catch(e){out.push(e.code)}fs.closeSync(fd);
try{fs.openSync(root+'/missing',c.O_WRONLY)}catch(e){out.push(e.code)}
console.log(JSON.stringify(out));`
for(const guestWasm of [false,true])test(`numeric file flags match Node: ${guestWasm}`,async({page},info)=>{
  const root=mkdtempSync(join(tmpdir(),'sandbox-flags-'))
  const oracle=spawnSync(process.execPath,['--input-type=module','-e',`const root=${JSON.stringify(root)};`+body],{encoding:'utf8',timeout:10000})
  expect(oracle.status,oracle.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({body,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`const root='';`+body})
    try{return await kernel.runModule('/main.mjs',{guestWasm})}finally{kernel.close()}
  },{body,guestWasm})
  await info.attach('flags.json',{body:JSON.stringify({oracle:oracle.stdout,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(oracle.stdout)
})
