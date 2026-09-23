import {test,expect} from '@playwright/test'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
const body=`
import fs from 'node:fs';import fsp from 'node:fs/promises';import {pathToFileURL} from 'node:url';import {Buffer} from 'node:buffer';
fs.mkdirSync(root+'/files');const url=pathToFileURL(root+'/files/a b%?.txt');
fs.writeFileSync(url,'first');const results=[fs.readFileSync(url,'utf8'),fs.existsSync(url),fs.statSync(url).isFile()];
await fsp.appendFile(url,' second');results.push(await fsp.readFile(url,'utf8'));
results.push(await new Promise((resolve,reject)=>fs.readFile(url,'utf8',(error,value)=>error?reject(error):resolve(value))));
const copy=pathToFileURL(root+'/files/copy.txt'),renamed=pathToFileURL(root+'/files/renamed.txt');
await fsp.copyFile(url,copy);fs.renameSync(copy,renamed);results.push(fs.readFileSync(Buffer.from(root+'/files/renamed.txt'),'utf8'));
const link=pathToFileURL(root+'/files/link');await fsp.symlink(renamed,link);results.push(fs.readFileSync(link,'utf8'));
results.push(fs.statSync(root+'/missing',{throwIfNoEntry:false})===undefined,fs.lstatSync(root+'/missing',{throwIfNoEntry:false})===undefined,fs.statSync(url.href+'/child',{throwIfNoEntry:false})===undefined);
try{fs.lstatSync(url.href+'/child',{throwIfNoEntry:false});results.push('accepted')}catch(error){results.push(error.code)}
for(const value of [new URL('https://example.com/a'),new URL('file://remote/a'),new URL('file:///a%2Fb'),{toString(){return url.href}},'bad\\0path']){
  try{fs.readFileSync(value);results.push('accepted')}catch(error){results.push(error.code)}
  try{await fsp.readFile(value);results.push('accepted')}catch(error){results.push(error.code)}
}
console.log(JSON.stringify(results));`
for(const guestWasm of [false,true])test(`${guestWasm?'WASM bridge':'default engine'}: filesystem paths match Node for URLs and Buffers`,async({page},info)=>{
  const root=mkdtempSync(join(tmpdir(),'sandbox-fs-paths-'))
  const oracle=spawnSync(process.execPath,['--input-type=module','-e',`const root=${JSON.stringify(root)};`+body],{encoding:'utf8',timeout:10000})
  expect(oracle.status,oracle.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({body,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`const root='';`+body})
    try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true})}finally{kernel.close()}
  },{body,guestWasm})
  await info.attach('filesystem-paths.json',{body:JSON.stringify({oracle:oracle.stdout,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(oracle.stdout)
})
