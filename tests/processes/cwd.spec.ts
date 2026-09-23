import {test,expect} from '@playwright/test'

for(const guestWasm of [false,true])test(`${guestWasm?'WASM bridge':'default engine'}: nested process directories and child inheritance`,async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async guestWasm=>{
    const source=`import fs from 'node:fs';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
      const exec=promisify(execFile),base=process.cwd(),out=[base,path.resolve('data'),fs.readFileSync('data','utf8')];
      process.chdir('sub');out.push(process.cwd());
      const fd=fs.openSync('../data','r'),bytes=Buffer.alloc(4);fs.readSync(fd,bytes,0,4,0);fs.closeSync(fd);out.push(bytes.toString());
      fs.writeFileSync('first','written');fs.renameSync('first','second');fs.copyFileSync('second','third');
      fs.symlinkSync('../data','link');out.push(fs.readlinkSync('link'),fs.readFileSync('link','utf8'));
      out.push((await exec(process.execPath,['-e',"console.log(JSON.stringify([process.cwd(),require('../value.cjs')]))"])).stdout.trim());
      const pending=exec(process.execPath,['-e',"console.log(process.cwd())"]);process.chdir('..');out.push((await pending).stdout.trim(),process.cwd());
      out.push((await exec(process.execPath,['--input-type=module','-e',"import value from './value.cjs';console.log(value)"],{cwd:'.'})).stdout.trim());
      try{process.chdir('missing')}catch(error){out.push(error.code)}
      try{process.chdir('data')}catch(error){out.push(error.code)}
      out.push(process.cwd());console.log(JSON.stringify(out));`
    const kernel=new window.sandboxLab.WorkerKernel({'/project/main.mjs':source,'/project/data':'data','/project/value.cjs':'module.exports=17','/project/sub/.keep':''})
    try{
      const child=await kernel.spawn('node',['main.mjs'],{cwd:'/project',guestWasm,webAPIs:true,timeoutMs:15000})
      const run=await child.wait();await child.dispose()
      const other=await kernel.spawn('node',['-e','console.log(process.cwd())'],{guestWasm})
      const root=await other.wait();await other.dispose()
      const execute=await kernel.runModule('/project/value.cjs',{cwd:'/project',guestWasm})
      return {run,root,execute,copy:await kernel.readText('/project/sub/third')}
    }finally{kernel.close()}
  },guestWasm)
  expect(result.run.exitCode,result.run.stderr).toBe(0)
  expect(JSON.parse(result.run.stdout)).toEqual(['/project','/project/data','data','/project/sub','data','../data','data','["/project/sub",17]','/project/sub','/project','17','ENOENT','ENOTDIR','/project'])
  expect(result.copy).toBe('written')
  expect(result.root.stdout).toBe('/\n')
  expect(result.execute.exitCode,result.execute.stderr).toBe(0)
})
