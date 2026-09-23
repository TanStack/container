import {test,expect} from '@playwright/test'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'

const body=`
import fs from 'node:fs';import fsp from 'node:fs/promises';import {promisify} from 'node:util';
import {Buffer} from 'node:buffer';import {AsyncLocalStorage} from 'node:async_hooks';
const path=root+'/file',out=[];
const privateFd=fs.openSync(root+'/private','w+',0o600);
out.push(fs.fstatSync(privateFd).mode&0o7777);
fs.writeFileSync(root+'/private','keep',{mode:0o777});out.push(fs.statSync(root+'/private').mode&0o7777);
fs.renameSync(root+'/private',root+'/renamed');out.push(fs.fstatSync(privateFd).mode&0o7777);
fs.unlinkSync(root+'/renamed');out.push(fs.fstatSync(privateFd).mode&0o7777);fs.closeSync(privateFd);
await fsp.writeFile(root+'/executable','x',{mode:0o777});out.push((await fsp.stat(root+'/executable')).mode&0o7777);
const directory=fs.openSync(root||'/','r',0);
out.push(fs.fstatSync(directory).isDirectory(),fs.fstatSync(directory).ino===fs.statSync(root||'/').ino);
try{fs.readSync(directory,Buffer.alloc(1),0,1,0)}catch(error){out.push(error.code)}
fs.closeSync(directory);
fs.writeFileSync(path,'abcdef');
const readHandle=await fsp.open(path,'r');await readHandle.read(Buffer.alloc(1),0,1,null);
out.push(await readHandle.readFile('utf8'),(await readHandle.readFile()).length);
await readHandle.close();try{await readHandle.readFile()}catch(error){out.push(error.code)}
const checkBig=(stat)=>{
  out.push(...['dev','ino','mode','nlink','uid','gid','rdev','size','blksize','blocks','atimeMs','mtimeMs','ctimeMs','birthtimeMs','atimeNs','mtimeNs','ctimeNs','birthtimeNs'].map(key=>typeof stat[key]));
  out.push(stat.size===6n,stat.isFile(),stat instanceof fs.Stats);
  for(const key of ['atime','mtime','ctime','birthtime'])out.push(stat[key] instanceof Date,stat[key+'Ns']/1000000n===stat[key+'Ms']);
};
checkBig(fs.statSync(path,{bigint:true}));checkBig(fs.lstatSync(path,{bigint:true}));
checkBig(await fsp.stat(path,{bigint:true}));checkBig(await fsp.lstat(path,{bigint:true}));
checkBig(await promisify(fs.stat)(path,{bigint:true}));
const bigHandle=await fsp.open(path,'r');checkBig(await bigHandle.stat({bigint:true}));
checkBig(fs.fstatSync(bigHandle.fd,{bigint:true}));await bigHandle.close();
const fd=fs.openSync(path,'r+'),other=fs.openSync(path,'r'),buffer=Buffer.alloc(8,95);
out.push(fs.readSync(fd,buffer,1,2,null),buffer.toString());
out.push(fs.readSync(fd,buffer,{offset:3,length:2,position:4}),buffer.toString());
out.push(fs.readSync(fd,buffer,0,2,null),buffer.toString());
fs.writeSync(fd,'X',0);fs.writeSync(fd,Buffer.from('Y'));
out.push(fs.readFileSync(path,'utf8'));
fs.renameSync(path,path+'-moved');fs.writeFileSync(path,'new');
out.push(fs.fstatSync(fd).size,fs.fstatSync(fd).isFile());
fs.unlinkSync(path+'-moved');fs.writeSync(fd,'Z',1);
const old=Buffer.alloc(6);fs.readSync(other,old,0,6,0);out.push(old.toString());
fs.ftruncateSync(fd,2);fs.writeSync(fd,'Q');out.push(fs.fstatSync(fd).size);
fs.closeSync(fd);fs.closeSync(other);
try{fs.fstatSync(fd)}catch(error){out.push(error.code)}
const open=promisify(fs.open),close=promisify(fs.close),read=promisify(fs.read),write=promisify(fs.write);
const asyncFd=await open(path,'a+');
const written=await write(asyncFd,'!',0,'utf8');out.push(written.bytesWritten,written.buffer);
const readBuffer=Buffer.alloc(4);const result=await read(asyncFd,readBuffer,0,4,null);
out.push(result.bytesRead,result.buffer===readBuffer,readBuffer.toString());
await close(asyncFd);
const handle=await fsp.open(path,'r+');const target=Buffer.alloc(3);
const fileRead=await handle.read(target,{offset:0,length:3,position:0});
out.push(fileRead.bytesRead,fileRead.buffer===target,target.toString());
out.push((await handle.write('A',1)).bytesWritten);await handle.truncate(3);
out.push((await handle.stat()).size);await handle.close();await handle.close();out.push(handle.fd);
const als=new AsyncLocalStorage();
await als.run('file-context',()=>new Promise((resolve,reject)=>fs.open(path,'r',(error,opened)=>{
  if(error)return reject(error);out.push(als.getStore());fs.close(opened,error=>error?reject(error):resolve());
})));
const large=fs.openSync(root+'/large','w+'),payload=Buffer.alloc(200003);
for(let i=0;i<payload.length;i++)payload[i]=i%251;
out.push(fs.writeSync(large,payload));const copy=Buffer.alloc(payload.length);
out.push(fs.readSync(large,copy,0,copy.length,0),copy.equals(payload));fs.closeSync(large);
const largeHandle=await fsp.open(root+'/large','r');out.push((await largeHandle.readFile()).equals(payload));await largeHandle.close();
console.log(JSON.stringify(out));`

for(const guestWasm of [false,true]){
  test(`${guestWasm?'WASM bridge':'default engine'}: descriptors match Node`,async({page},info)=>{
    const root=mkdtempSync(join(tmpdir(),'sandbox-fs-descriptors-'))
    const oracle=spawnSync(process.execPath,['--input-type=module','-e',`process.umask(0o022);const root=${JSON.stringify(root)};`+body],{encoding:'utf8',timeout:10000,env:{...process.env,FORCE_COLOR:'0'}})
    expect(oracle.status,oracle.stderr).toBe(0)
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({body,guestWasm})=>{
      const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`const root='';`+body})
      try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
    },{body,guestWasm})
    await info.attach('descriptors.json',{body:JSON.stringify({oracle:oracle.stdout,result}),contentType:'application/json'})
    expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(oracle.stdout)
  })
  test(`${guestWasm?'WASM bridge':'default engine'}: process cleanup releases descriptor and byte quotas`,async({page})=>{
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async guestWasm=>{
      const source=`import fs from 'node:fs';
        const bytes=new Uint8Array(65536);fs.writeFileSync('/data',bytes);
        for(let i=0;i<64;i++)fs.openSync('/data','r');
        try{fs.openSync('/data','r');throw Error('quota missing')}catch(error){if(error.code!=='EMFILE')throw error}
        fs.unlinkSync('/data');console.log('done');`
      const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source},{workspace:{maxBytes:70000}})
      const results=[]
      try{for(let i=0;i<6;i++)results.push(await kernel.runModule('/main.mjs',{guestWasm}));return results}finally{kernel.close()}
    },guestWasm)
    for(const run of result){expect(run.exitCode,run.stderr).toBe(0);expect(run.stdout).toBe('done\n')}
  })
}
