import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const cases:Record<string,string>={
  'inherited stderr with piped stdout':`
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e',"process.stdout.write('out');process.stderr.write('err')"],{stdio:['pipe','pipe','inherit']});
    let output='';child.stdout.on('data',bytes=>output+=bytes);const closed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve([code,signal]))});child.stdin.end();
    console.log(JSON.stringify([child.stderr,child.stdio.map(x=>x===null),await closed,output]));`,
  'inherited stdout with ignored stderr':String.raw`
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e',"process.stdout.write('inherited\\n');process.stderr.write('discard')"],{stdio:['ignore','inherit','ignore']});
    const closed=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code))});console.log(JSON.stringify([child.stdio,closed]));`,
  'ignored input provides EOF':`
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e',"process.stdin.on('data',()=>{throw Error('unexpected input')});process.stdin.on('end',()=>console.log('eof'))"],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.resume();await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});console.log(JSON.stringify([child.stdin,output]));`,
  'all inherited streams and numeric standard endpoints':String.raw`
    import {spawn} from 'node:child_process';
    for(const stdio of ['inherit',[0,1,2]]){
      const child=spawn(process.execPath,['-e',"process.stdin.pipe(process.stdout);process.stderr.write('inherited-error\\n')"],{stdio});
      await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('child exit '+code)))});console.log(JSON.stringify(child.stdio));
    }`,
  'nested inheritance routes output once':String.raw`
    import {spawn} from 'node:child_process';
    const leaf="process.stdout.write('leaf-out\\n');process.stderr.write('leaf-err\\n')";
    const middle="const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',"+JSON.stringify(leaf)+"],{stdio:'inherit'});child.on('error',error=>{throw error});child.on('close',code=>{if(code!==0)throw Error('leaf exit '+code)})";
    const child=spawn(process.execPath,['-e',middle],{stdio:['ignore','inherit','inherit']});
    await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('child exit '+code)))});console.log('done');`,
  'execFile retains its buffered output contract':`
    import {execFile} from 'node:child_process';
    const output=await new Promise((resolve,reject)=>execFile(process.execPath,['-e',"process.stdout.write('out');process.stderr.write('err')"],{stdio:'inherit'},(error,stdout,stderr)=>error?reject(error):resolve([stdout,stderr])));console.log(JSON.stringify(output));`,
}

for(const guestWasm of [false,true])for(const [name,body] of Object.entries(cases))test(`${guestWasm?'WASM bridge':'default engine'}: ${name}`,async({page},info)=>{
  const oracle=spawnSync(process.execPath,['--input-type=module','-e',body],{encoding:'utf8',timeout:10000,input:'input\n',env:{...process.env,FORCE_COLOR:'0'}})
  expect(oracle.status,oracle.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({body,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':body})
    try{
      const child=await kernel.spawn('node',['/main.mjs'],{guestWasm,webAPIs:true,timeoutMs:10000})
      await child.write(new TextEncoder().encode('input\n'));await child.end()
      return await child.wait()
    }finally{kernel.close()}
  },{body,guestWasm})
  await info.attach('stdio.json',{body:JSON.stringify({node:{stdout:oracle.stdout,stderr:oracle.stderr},result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(oracle.stdout);expect(result.stderr).toBe(oracle.stderr)
})
