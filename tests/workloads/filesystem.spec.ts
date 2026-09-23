import {test,expect} from '@playwright/test'
import {mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'

const cases:Record<string,string>={
  'directories, Dirents, recursive listing, rename, and removal':`
    const seen=[];
    seen.push(fs.mkdirSync(ROOT+'/a/b',{recursive:true}),fs.mkdirSync(ROOT+'/a/b',{recursive:true}));
    fs.mkdirSync(ROOT+'/empty');fs.writeFileSync(ROOT+'/a/b/é.txt','value');
    seen.push(fs.readdirSync(ROOT,{recursive:true}).sort());
    seen.push(fs.readdirSync(ROOT,{recursive:true,withFileTypes:true}).map(d=>[d.name,d.parentPath,d.isFile(),d.isDirectory(),d.isSymbolicLink(),d instanceof fs.Dirent]).sort());
    seen.push(fs.readdirSync(ROOT+'/a/b',{encoding:'buffer'}).map(b=>[Buffer.isBuffer(b),b.toString('hex')]));
    fs.renameSync(ROOT+'/a',ROOT+'/moved');seen.push(fs.existsSync(ROOT+'/a'),fs.readFileSync(ROOT+'/moved/b/é.txt','utf8'));
    fs.rmdirSync(ROOT+'/empty');fs.rmSync(ROOT+'/moved',{recursive:true});seen.push(fs.readdirSync(ROOT));
    console.log(JSON.stringify(seen));`,
  'write flags, byte views, encodings, copying, and truncation':`
    const file=ROOT+'/file',seen=[];fs.writeFileSync(file,'ABCDEF');
    seen.push(fs.writeFileSync(file,'xy',{flag:'r+'}),fs.readFileSync(file,'utf8'));
    fs.appendFileSync(file,'é',{encoding:'utf16le'});seen.push(fs.readFileSync(file,'hex'));
    const view=new Uint8Array([99,0,128,255,88]).subarray(1,4);fs.writeFileSync(ROOT+'/bytes',view);
    seen.push(fs.readFileSync(ROOT+'/bytes','base64'),Buffer.isBuffer(fs.readFileSync(file)));
    fs.copyFileSync(file,ROOT+'/copy',fs.constants.COPYFILE_FICLONE);seen.push(fs.readFileSync(ROOT+'/copy','hex'));
    for(const fn of [()=>fs.writeFileSync(file,'x',{flag:'wx'}),()=>fs.copyFileSync(file,ROOT+'/copy',fs.constants.COPYFILE_EXCL),()=>fs.writeFileSync(ROOT+'/missing','x',{flag:'r+'})]){try{fn()}catch(e){seen.push(e.code)}}
    fs.truncateSync(file,3);seen.push(fs.readFileSync(file,'hex'));fs.truncateSync(file,6);seen.push(fs.readFileSync(file,'hex'));fs.truncateSync(file,-3);seen.push(fs.readFileSync(file,'hex'));
    console.log(JSON.stringify(seen));`,
  'filesystem errors preserve data and directory distinctions':`
    fs.mkdirSync(ROOT+'/a');fs.mkdirSync(ROOT+'/b');fs.writeFileSync(ROOT+'/a/file','before');fs.writeFileSync(ROOT+'/b/file','other');
    const seen=[];
    for(const fn of [()=>fs.mkdirSync(ROOT+'/a'),()=>fs.mkdirSync(ROOT+'/absent/child'),()=>fs.writeFileSync(ROOT+'/absent/file','x'),()=>fs.readFileSync(ROOT+'/a'),()=>fs.readdirSync(ROOT+'/a/file'),()=>fs.rmdirSync(ROOT+'/a'),()=>fs.renameSync(ROOT+'/a',ROOT+'/a/child'),()=>fs.renameSync(ROOT+'/a',ROOT+'/b'),()=>fs.renameSync(ROOT+'/a/file',ROOT+'/b'),()=>fs.renameSync(ROOT+'/a',ROOT+'/b/file')]){
      try{fn();seen.push('unexpected')}catch(e){seen.push(e.code)}
    }
    // macOS returns EPERM, Linux returns EISDIR for unlink of a directory.
    try{fs.unlinkSync(ROOT+'/a');seen.push('unexpected')}catch(e){if(!['EPERM','EISDIR'].includes(e.code))throw e;seen.push('directory unlink refused')}
    fs.rmSync(ROOT+'/absent',{force:true});seen.push(fs.readFileSync(ROOT+'/a/file','utf8'),fs.readFileSync(ROOT+'/b/file','utf8'));
    console.log(JSON.stringify(seen));`,
  'callbacks and promises preserve directory values and async context':`
    const als=new AsyncLocalStorage(),seen=[];
    await als.run('operation',async()=>{
      seen.push(await fsp.mkdir(ROOT+'/a/b',{recursive:true}),als.getStore());
      await promisify(fs.writeFile)(ROOT+'/a/b/file','abc');await fsp.appendFile(ROOT+'/a/b/file','def');
      await promisify(fs.copyFile)(ROOT+'/a/b/file',ROOT+'/copy');await fsp.rename(ROOT+'/copy',ROOT+'/renamed');
      await fsp.truncate(ROOT+'/renamed',3);seen.push(await fsp.readFile(ROOT+'/renamed','utf8'));
      seen.push((await fsp.readdir(ROOT+'/a',{withFileTypes:true})).map(d=>[d.name,d.isDirectory(),d instanceof fs.Dirent]));
      await promisify(fs.unlink)(ROOT+'/renamed');await fsp.rm(ROOT+'/a',{recursive:true});seen.push(await fsp.readdir(ROOT),als.getStore());
    });
    console.log(JSON.stringify(seen));`,
}

for(const [name,code] of Object.entries(cases))for(const execution of ['modules','bundle'] as const){
  test('Filesystem | '+execution+' | '+name,async({page},info)=>{
    const root=info.outputPath('node-files');mkdirSync(root,{recursive:true})
    const imports=`import fs from 'node:fs';import fsp from 'node:fs/promises';import {Buffer} from 'node:buffer';import {promisify} from 'node:util';import {AsyncLocalStorage} from 'node:async_hooks';`
    const node=spawnSync(process.execPath,['--input-type=module'],{input:imports+`const ROOT=${JSON.stringify(root)};`+code,encoding:'utf8',timeout:10000})
    expect(node.status,node.stderr).toBe(0)
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({source,execution})=>{
      const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':source})
      try{
        const snapshot=await kernel.snapshot()
        await kernel.restore({...snapshot,version:2,directories:['/work']})
        return await (execution==='modules'?kernel.runModule('/entry.mjs'):kernel.run('/entry.mjs'))
      }finally{kernel.close()}
    },{source:imports+`const ROOT='/work';`+code,execution})
    expect(result.exitCode,result.stderr).toBe(0)
    expect(result.stdout).toBe(node.stdout.replaceAll(root,'/work'))
  })
}

test('Filesystem | read-only mutations, directory checkpoints, quotas, and recovery',async({page})=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/data/file':'value'})
    try{
      const run=async(source:string,options={})=>{await kernel.writeText('/check.mjs',source);return kernel.runModule('/check.mjs',options)}
      const setup=await run(`import fs from 'node:fs';fs.mkdirSync('/empty/nested',{recursive:true})`)
      const before=await kernel.snapshot()
      const denied=await run(`import fs from 'node:fs';const seen=[];for(const fn of [()=>fs.mkdirSync('/denied'),()=>fs.rmSync('/data',{recursive:true}),()=>fs.rmdirSync('/empty/nested'),()=>fs.unlinkSync('/data/file'),()=>fs.renameSync('/data','/moved'),()=>fs.copyFileSync('/data/file','/copy'),()=>fs.truncateSync('/data/file',0),()=>fs.appendFileSync('/data/file','no')]){try{fn();seen.push('unexpected')}catch(e){seen.push(e.code)}}console.log(JSON.stringify(seen))`,{writable:false})
      const after=await kernel.snapshot()
      // The host replaces the test entry, but no guest mutation may change data.
      after.files['/check.mjs']=before.files['/check.mjs']
      const mutate=await run(`import fs from 'node:fs';fs.rmSync('/empty',{recursive:true});fs.writeFileSync('/data/file','changed')`)
      await kernel.restore(before)
      const restored=await run(`import fs from 'node:fs';console.log(JSON.stringify([fs.readdirSync('/empty/nested'),fs.readFileSync('/data/file','utf8')]))`)
      const quota=await run(`import fs from 'node:fs';try{fs.truncateSync('/data/file',33554433)}catch(e){console.log(e.code)}console.log(fs.readFileSync('/data/file','utf8'))`)
      return {setup,denied,before,after,mutate,restored,quota}
    }finally{kernel.close()}
  })
  expect(results.setup.exitCode,results.setup.stderr).toBe(0)
  expect(results.denied.exitCode,results.denied.stderr).toBe(0)
  expect(JSON.parse(results.denied.stdout)).toEqual(Array(8).fill('EACCES'))
  expect(results.after).toEqual(results.before)
  expect(results.before.version).toBe(3)
  expect(results.mutate.exitCode,results.mutate.stderr).toBe(0)
  expect(results.restored.exitCode,results.restored.stderr).toBe(0)
  expect(JSON.parse(results.restored.stdout)).toEqual([[],'value'])
  expect(results.quota.stdout).toBe('ENOSPC\nvalue\n')
})
