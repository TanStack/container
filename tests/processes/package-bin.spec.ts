import {expect,test} from '@playwright/test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'

const source=`
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
const cwd=process.cwd(),packageBin=path.join(cwd,'node_modules/package/cli.js'),linkedBin=path.join(cwd,'node_modules/.bin/demo'),shadow=path.join(cwd,'shadow/demo');
fs.mkdirSync(path.dirname(packageBin),{recursive:true});fs.mkdirSync(path.dirname(linkedBin),{recursive:true});fs.mkdirSync(path.dirname(shadow),{recursive:true});
fs.writeFileSync(packageBin,"#!/usr/bin/env node\\nconsole.log(JSON.stringify([process.argv.slice(1),process.env.PROBE]))\\n",{mode:0o644});
fs.chmodSync(packageBin,0o755);fs.symlinkSync('../package/cli.js',linkedBin);fs.writeFileSync(shadow,'#!/usr/bin/env node\\nconsole.log("wrong")\\n',{mode:0o644});
const run=(command,args=[],env={...process.env})=>new Promise(resolve=>{const child=spawn(command,args,{cwd,env}),chunks=[];child.stdout?.on('data',chunk=>chunks.push(chunk));child.once('error',error=>resolve({error:error.code}));child.once('close',(code,signal)=>resolve({code,signal,stdout:Buffer.concat(chunks).toString()}))});
const PATH=[path.join(cwd,'shadow'),path.join(cwd,'node_modules/.bin'),'/usr/bin','/bin'].join(':');
const ok=await run('demo',['two words'],{PATH,PROBE:'kept'});fs.chmodSync(packageBin,0o644);
const denied=await run('demo',[],{PATH:path.join(cwd,'node_modules/.bin')});const missing=await run('absent',[],{PATH});
console.log(JSON.stringify({ok,denied,missing,mode:fs.statSync(packageBin).mode&0o777,link:fs.realpathSync(linkedBin)===packageBin}));`

test('package bin links resolve through PATH and require executable permission',async({page},info)=>{
  const root=mkdtempSync(join(tmpdir(),'web-container-package-bin-'))
  try{
    const native=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:root,encoding:'utf8',timeout:10000})
    expect(native.status,native.stderr).toBe(0)
    const expected=JSON.parse(native.stdout)
    await page.goto('/sandbox.html')
    const results=await page.evaluate(async source=>{
      const output=[]
      for(const guestWasm of [false,true]){
        const kernel=new window.sandboxLab.WorkerKernel({'/project/main.mjs':source})
        try{output.push(await kernel.runModule('/project/main.mjs',{cwd:'/project',guestWasm,timeoutMs:10000}))}finally{kernel.close()}
      }
      return output
    },source)
    await info.attach('native-package-bin.json',{body:native.stdout,contentType:'application/json'})
    expect(expected).toMatchObject({ok:{code:0,signal:null},denied:{error:'EACCES'},missing:{error:'ENOENT'},mode:0o644,link:true})
    for(const result of results){expect(result.exitCode,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual(expected)}
  }finally{rmSync(root,{recursive:true,force:true})}
})
