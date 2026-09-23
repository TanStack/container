import {test,expect} from '@playwright/test'
import {mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'

const imports=`import fs from 'node:fs';import fsp from 'node:fs/promises';import {promisify} from 'node:util';import {AsyncLocalStorage} from 'node:async_hooks';`
const cases:Record<string,string>={
  'relative, absolute, dangling links and writes through links':`
    fs.mkdirSync(ROOT+'/real/deep',{recursive:true});fs.writeFileSync(ROOT+'/real/deep/file','abc');fs.writeFileSync(ROOT+'/real/sibling','right');fs.writeFileSync(ROOT+'/sibling','wrong');
    fs.symlinkSync('real/deep',ROOT+'/dir');fs.symlinkSync(ROOT+'/dir/file',ROOT+'/absolute');fs.symlinkSync('later',ROOT+'/dangling');
    const seen=[fs.readlinkSync(ROOT+'/dir'),fs.realpathSync(ROOT+'/absolute'),fs.readFileSync(ROOT+'/dir/../sibling','utf8'),fs.existsSync(ROOT+'/dangling')];
    fs.writeFileSync(ROOT+'/absolute','new');seen.push(fs.readFileSync(ROOT+'/real/deep/file','utf8'));
    for(const flag of ['wx','ax']){try{fs.writeFileSync(ROOT+'/dangling','bad',{flag})}catch(e){seen.push(e.code)}}
    fs.writeFileSync(ROOT+'/dangling','created');seen.push(fs.readFileSync(ROOT+'/later','utf8'),fs.readlinkSync(ROOT+'/dangling'));
    console.log(JSON.stringify(seen));`,
  'stat, lstat, Dirent identity and directory aliases':`
    fs.mkdirSync(ROOT+'/real/deep',{recursive:true});fs.writeFileSync(ROOT+'/real/deep/file','abc');fs.symlinkSync('real',ROOT+'/alias');fs.symlinkSync('missing',ROOT+'/dangling');
    const describe=s=>[s.isFile(),s.isDirectory(),s.isSymbolicLink(),s.isBlockDevice(),s.isCharacterDevice(),s.isFIFO(),s.isSocket(),s instanceof fs.Stats,s instanceof fs.Dirent];
    const seen=[describe(fs.statSync(ROOT+'/alias')),describe(fs.lstatSync(ROOT+'/alias')),describe(fs.lstatSync(ROOT+'/dangling')),fs.lstatSync(ROOT+'/alias').size];
    seen.push(fs.readdirSync(ROOT,{withFileTypes:true}).map(d=>[d.name,d.isDirectory(),d.isSymbolicLink(),d instanceof fs.Dirent]).sort());
    for(const path of [ROOT+'/alias',ROOT+'/alias/',ROOT+'/real/../alias']){
      seen.push(fs.readdirSync(path,{recursive:true}).sort(),fs.readdirSync(path,{recursive:true,withFileTypes:true}).map(d=>[d.name,d.parentPath,d.isFile(),d.isDirectory()]).sort());
    }
    console.log(JSON.stringify(seen));`,
  'unlink, rename, copy and recursive deletion preserve link targets':`
    fs.mkdirSync(ROOT+'/real');fs.writeFileSync(ROOT+'/real/file','safe');fs.symlinkSync('real',ROOT+'/alias');fs.renameSync(ROOT+'/alias',ROOT+'/moved');
    const seen=[fs.readlinkSync(ROOT+'/moved'),fs.existsSync(ROOT+'/alias')];
    try{fs.rmdirSync(ROOT+'/moved')}catch(e){seen.push(e.code)}
    fs.rmSync(ROOT+'/moved',{recursive:true});seen.push(fs.readFileSync(ROOT+'/real/file','utf8'));
    fs.symlinkSync('real/file',ROOT+'/file-link');fs.copyFileSync(ROOT+'/file-link',ROOT+'/copy');fs.unlinkSync(ROOT+'/file-link');
    fs.mkdirSync(ROOT+'/tree');fs.symlinkSync('../real',ROOT+'/tree/external');fs.rmSync(ROOT+'/tree',{recursive:true});
    fs.symlinkSync('real/file',ROOT+'/destination');fs.renameSync(ROOT+'/copy',ROOT+'/destination');
    seen.push(fs.lstatSync(ROOT+'/destination').isFile(),fs.readFileSync(ROOT+'/real/file','utf8'),fs.readFileSync(ROOT+'/destination','utf8'));
    console.log(JSON.stringify(seen));`,
  'loop limits, missing targets and invalid link operations':`
    fs.writeFileSync(ROOT+'/file','safe');fs.symlinkSync('b',ROOT+'/a');fs.symlinkSync('a',ROOT+'/b');fs.symlinkSync('missing',ROOT+'/dangling');
    const seen=[];for(const fn of [()=>fs.statSync(ROOT+'/a'),()=>fs.realpathSync(ROOT+'/a'),()=>fs.readFileSync(ROOT+'/a'),()=>fs.writeFileSync(ROOT+'/a','bad'),()=>fs.readlinkSync(ROOT+'/file'),()=>fs.symlinkSync('file',ROOT+'/dangling'),()=>fs.readFileSync(ROOT+'/dangling'),()=>fs.symlinkSync('x',ROOT+'/absent/link')]){
      try{fn();seen.push('unexpected')}catch(e){seen.push(e.code)}
    }
    seen.push(fs.existsSync(ROOT+'/a'),fs.lstatSync(ROOT+'/a').isSymbolicLink(),fs.readlinkSync(ROOT+'/a'),fs.readFileSync(ROOT+'/file','utf8'));
    console.log(JSON.stringify(seen));`,
  'callbacks, promises, encodings and async context':`
    const als=new AsyncLocalStorage(),seen=[];fs.writeFileSync(ROOT+'/é.txt','abc');
    await als.run('context',async()=>{
      await fsp.symlink('é.txt',ROOT+'/a');await promisify(fs.symlink)('a',ROOT+'/b','file');
      seen.push(await fsp.readlink(ROOT+'/a'),await promisify(fs.readlink)(ROOT+'/b'),als.getStore());
      for(const read of [()=>fs.readlinkSync(ROOT+'/a','buffer'),()=>fsp.readlink(ROOT+'/a',{encoding:'buffer'}),()=>promisify(fs.readlink)(ROOT+'/a','buffer')]){const b=await read();seen.push(Buffer.isBuffer(b),b.toString('hex'))}
      seen.push((await fsp.stat(ROOT+'/b')) instanceof fs.Stats,(await fsp.lstat(ROOT+'/b')).isSymbolicLink(),await fsp.realpath(ROOT+'/b'),als.getStore());
    });console.log(JSON.stringify(seen));`,
}

for(const [name,code] of Object.entries(cases))for(const execution of ['modules','bundle'] as const){
  test('Symlinks | '+execution+' | '+name,async({page},info)=>{
    const root=info.outputPath('node-files');mkdirSync(root,{recursive:true})
    const node=spawnSync(process.execPath,['--input-type=module'],{input:imports+`const ROOT=${JSON.stringify(root)};`+code,encoding:'utf8',timeout:10000})
    expect(node.status,node.stderr).toBe(0)
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({source,execution})=>{
      const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':source})
      try{
        const snapshot=await kernel.snapshot();await kernel.restore({...snapshot,version:3,directories:['/work'],symlinks:{}})
        return await (execution==='modules'?kernel.runModule('/entry.mjs'):kernel.run('/entry.mjs'))
      }finally{kernel.close()}
    },{source:imports+`const ROOT='/work';`+code,execution})
    expect(result.exitCode,result.stderr).toBe(0)
    expect(result.stdout).toBe(node.stdout.replaceAll(root,'/work'))
  })
}

test('Symlinks | module identity, package links, and bundle compilation',async({page},info)=>{
  const code=`
    fs.mkdirSync(ROOT+'/real',{recursive:true});fs.mkdirSync(ROOT+'/node_modules');
    fs.writeFileSync(ROOT+'/real/package.json','{"name":"linked","type":"module","exports":"./value.js"}');
    fs.writeFileSync(ROOT+'/real/child.js','export default 42');
    fs.writeFileSync(ROOT+'/real/value.js',"export {default} from './child.js';export const url=import.meta.url");
    fs.writeFileSync(ROOT+'/real/value.cjs','module.exports={value:42}');
    fs.symlinkSync('../real',ROOT+'/node_modules/linked');fs.symlinkSync('real/value.cjs',ROOT+'/alias.cjs');fs.symlinkSync('real/value.js',ROOT+'/alias.mjs');
  `
  const entry=`import value,{url} from 'linked';import other from './alias.mjs';import {createRequire} from 'node:module';
    const require=createRequire(import.meta.url);const first=require('./alias.cjs'),second=require('./real/value.cjs');
    const a=await import('./alias.mjs?one'),b=await import('./real/value.js?one'),c=await import('./real/value.js?two');
    console.log(JSON.stringify([value,other,first===second,a===b,a===c,url.endsWith('/real/value.js'),require.resolve('./alias.cjs').endsWith('/real/value.cjs')]));`
  const root=info.outputPath('node-files');mkdirSync(root,{recursive:true})
  const node=spawnSync(process.execPath,['--input-type=module'],{input:imports+`const ROOT=${JSON.stringify(root)};`+code+`fs.writeFileSync(ROOT+'/entry.mjs',${JSON.stringify(entry)});await import(ROOT+'/entry.mjs');`,encoding:'utf8',timeout:10000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({setup,entry})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/setup.mjs':setup})
    try{
      const setupResult=await kernel.runModule('/setup.mjs');if(setupResult.exitCode)return {setupResult}
      await kernel.writeText('/entry.mjs',entry)
      const modules=await kernel.runModule('/entry.mjs'),snapshot=await kernel.snapshot()
      // Compile a static linked package and a linked relative import from the
      // checkpoint. Dynamic require is tested above in the runtime loader.
      await kernel.writeText('/bundle.mjs',`import a from 'linked';import b from './alias.mjs';console.log(JSON.stringify([a,b]));`)
      const bundle=await kernel.run('/bundle.mjs')
      await kernel.restore(snapshot)
      const restored=await kernel.runModule('/entry.mjs')
      return {setupResult,modules,bundle,restored}
    }finally{kernel.close()}
  },{setup:imports+`const ROOT='';`+code,entry})
  expect(result.setupResult.exitCode,result.setupResult.stderr).toBe(0)
  expect(result.modules?.exitCode,result.modules?.stderr).toBe(0)
  expect(result.modules?.stdout).toBe(node.stdout)
  expect(result.bundle?.exitCode,result.bundle?.stderr).toBe(0)
  expect(result.bundle?.stdout).toBe('[42,42]\n')
  expect(result.restored?.stdout).toBe(node.stdout)
})

test('Symlinks | read-only authority and checkpoint restoration',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/file':'safe','/setup.mjs':`import fs from 'node:fs';fs.symlinkSync('file','/link')`})
    try{
      const setup=await kernel.runModule('/setup.mjs'),before=await kernel.snapshot()
      await kernel.writeText('/deny.mjs',`import fs from 'node:fs';const seen=[];for(const fn of [()=>fs.symlinkSync('file','/new'),()=>fs.writeFileSync('/link','bad'),()=>fs.unlinkSync('/link')]){try{fn();seen.push('unexpected')}catch(e){seen.push(e.code)}}console.log(JSON.stringify(seen));`)
      const denied=await kernel.runModule('/deny.mjs',{writable:false})
      const after=await kernel.snapshot();delete after.files['/deny.mjs']
      await kernel.writeText('/change.mjs',`import fs from 'node:fs';fs.unlinkSync('/link');fs.writeFileSync('/file','changed')`)
      await kernel.runModule('/change.mjs');await kernel.restore(before)
      await kernel.writeText('/read.mjs',`import fs from 'node:fs';console.log(JSON.stringify([fs.readlinkSync('/link'),fs.readFileSync('/link','utf8')]));`)
      const restored=await kernel.runModule('/read.mjs')
      return {setup,before,after,denied,restored}
    }finally{kernel.close()}
  })
  expect(result.setup.exitCode,result.setup.stderr).toBe(0)
  expect(result.denied.stdout).toBe('["EACCES","EACCES","EACCES"]\n')
  expect(result.after).toEqual(result.before)
  expect(result.restored.stdout).toBe('["file","safe"]\n')
})
