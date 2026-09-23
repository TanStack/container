import {test,expect} from '@playwright/test'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {spawnSync} from 'node:child_process'

const fixtures:Record<string,Record<string,string>>={
  'Node globals and filesystem import order':{
    '/entry.cjs':`const promises=require('node:fs/promises'),fs=require('node:fs');console.log(JSON.stringify([global===globalThis,Buffer===require('node:buffer').Buffer,process===require('node:process'),fs.promises===promises]));`,
  },
  'bare dot and parent directory requires':{
    '/package.json':'{"type":"commonjs"}',
    '/entry.cjs':`console.log(JSON.stringify(require('./child/entry.cjs')))`,
    '/index.js':`module.exports=3`,
    '/child/index.js':`module.exports=7`,
    '/child/entry.cjs':`module.exports=[require('.'),require('..')]`,
  },
  'computed require and cache invalidation':{
    '/entry.cjs':`const fs=require('node:fs');const name='./value.cjs';
      const a=require(name);fs.writeFileSync((globalThis.__fixtureRoot??'')+'/value.cjs','module.exports={value:7}');
      const b=require(name);delete require.cache[require.resolve(name)];const c=require(name);
      console.log(JSON.stringify([a.value,b.value,c.value,a===b,a===c,require.main===module]));`,
    '/value.cjs':`module.exports={value:3}`,
  },
  'CommonJS cycles and failed module retry':{
    '/entry.cjs':`const a=require('./a.cjs');let errors=0;for(let i=0;i<2;i++){try{require('./bad.cjs')}catch{errors++}}
      console.log(JSON.stringify([a.seen,a.done,errors,globalThis.attempts]));`,
    '/a.cjs':`exports.done=false;exports.seen=require('./b.cjs').seen;exports.done=true`,
    '/b.cjs':`exports.seen=require('./a.cjs').done`,
    '/bad.cjs':`globalThis.attempts=(globalThis.attempts||0)+1;throw Error('failed')`,
  },
  'native ESM live bindings, top-level await, and computed import':{
    '/package.json':'{"type":"module"}',
    '/entry.js':`import {value,increment} from './value.js';increment();await 0;
      const name='./value.js';const again=await import(name);
      const third=await import(new URL('./value.js',import.meta.url).href);console.log(JSON.stringify([value,again.value,again===third]));`,
    '/value.js':`export let value=3;export function increment(){value++}`,
  },
  'package imports and conditional require':{
    '/package.json':'{"type":"module","imports":{"#value":"./value.cjs"}}',
    '/entry.mjs':`import {createRequire} from 'node:module';const require=createRequire(import.meta.url);
      import value from 'choice';console.log(JSON.stringify([value,require('choice'),require('#value')]));`,
    '/value.cjs':`module.exports=9`,
    '/node_modules/choice/package.json':'{"exports":{"import":"./import.mjs","require":"./require.cjs"}}',
    '/node_modules/choice/import.mjs':`export default 3`,
    '/node_modules/choice/require.cjs':`module.exports=7`,
  },
  'CommonJS named exports, reexports, and builtin identity':{
    '/entry.mjs':`import {value} from './forward.cjs';import fs,{readFileSync} from 'node:fs';import {createRequire} from 'node:module';
      const require=createRequire(import.meta.url);console.log(JSON.stringify([value,fs===require('fs'),readFileSync===require('fs').readFileSync]));`,
    '/forward.cjs':`module.exports=require('./value.cjs')`,
    '/value.cjs':`exports.value=42`,
  },
  'computed import from CommonJS uses the module filename':{
    '/entry.cjs':`const file='./child.mjs';import(file).then(value=>console.log(value.default));`,
    '/child.mjs':`export default 42`,
  },
  'resolution errors preserve Node error codes':{
    '/entry.cjs':`const codes=[];for(const name of ['missing-package','pkg/private','node:no_such_builtin']){try{require(name)}catch(error){codes.push(error.code)}}console.log(JSON.stringify(codes));`,
    '/node_modules/pkg/package.json':'{"exports":{".":"./index.cjs"}}','/node_modules/pkg/index.cjs':'',
  },
  'module URLs, fragments, and file URL roundtrip':{
    '/entry.mjs':`import {pathToFileURL,fileURLToPath} from 'node:url';import {createRequire} from 'node:module';
      const require=createRequire(import.meta.url);const paths=['/a b/#?.js','/100%/é.js','/tab\\t.js'];
      const a=await import('./child.mjs?first'),b=await import('./child.mjs?second');
      const encoded=await import('encoded');const same=await import('./node_modules/encoded/a%20b.mjs?one');
      const nested=await import('./100%25/parent.mjs');
      const root=globalThis.__fixtureRoot??'';
      console.log(JSON.stringify([fileURLToPath(import.meta.url)===root+'/entry.mjs',import.meta.filename===root+'/entry.mjs',import.meta.dirname===(root||'/'),require('./answer.cjs'),a===b,a.url!==b.url,paths.every(p=>fileURLToPath(pathToFileURL(p))===p),encoded===same,nested.default,import.meta.resolve('node:fs')==='node:fs',fileURLToPath(import.meta.resolve('encoded'))===root+'/node_modules/encoded/a b.mjs',import.meta.resolve('./child.mjs?resolved')===new URL('./child.mjs?resolved',import.meta.url).href]));`,
    '/child.mjs':`export const url=import.meta.url`,
    '/answer.cjs':`module.exports=42`,
    '/node_modules/encoded/package.json':'{"exports":"./a%20b.mjs?one"}',
    '/node_modules/encoded/a b.mjs':`export const value=42`,
    '/100%/parent.mjs':`export {default} from './child.mjs'`,
    '/100%/child.mjs':`export default 42`,
  },
  'host edits can introduce a new module during execution':{
    '/entry.mjs':`console.log('ready');await new Promise(resolve=>setTimeout(resolve,100));
      const name='/created.mjs';console.log((await import(name)).default);`,
  },
}
const expected:Record<string,string>={
  'Node globals and filesystem import order':'[true,true,true,true]',
  'bare dot and parent directory requires':'[7,3]',
  'computed require and cache invalidation':'[3,3,7,true,false,true]',
  'CommonJS cycles and failed module retry':'[false,true,2,2]',
  'native ESM live bindings, top-level await, and computed import':'[4,4,true]',
  'package imports and conditional require':'[3,7,9]',
  'CommonJS named exports, reexports, and builtin identity':'[42,true,true]',
  'computed import from CommonJS uses the module filename':'42',
  'resolution errors preserve Node error codes':'["MODULE_NOT_FOUND","ERR_PACKAGE_PATH_NOT_EXPORTED","ERR_UNKNOWN_BUILTIN_MODULE"]',
  'module URLs, fragments, and file URL roundtrip':'[true,true,true,42,false,true,true,true,42,true,true,true]',
  'host edits can introduce a new module during execution':'ready\n42',
}
for(const [name,files] of Object.entries(fixtures))test('runtime modules | '+name,async({page},info)=>{
  if(!name.startsWith('host edits')){
    const directory=info.outputPath('node-reference')
    for(const [path,source] of Object.entries(files)){
      const target=join(directory,path.slice(1))
      if(!target.startsWith(directory+'/'))throw Error('Fixture path escaped reference directory')
      mkdirSync(dirname(target),{recursive:true})
      const prefix=path.startsWith('/entry.')?'globalThis.__fixtureRoot='+JSON.stringify(directory)+';\n':''
      writeFileSync(target,prefix+source)
    }
    const entry=Object.keys(files).find(path=>path.startsWith('/entry.'))!
    const node=spawnSync(process.execPath,[join(directory,entry.slice(1))],{encoding:'utf8',timeout:10000,env:{...process.env,FORCE_COLOR:'0'}})
    expect(node.status,node.stderr).toBe(0)
    expect(node.stdout.trim()).toBe(expected[name])
  }
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    let edit:Promise<void>|undefined
    try{
      const entry=Object.keys(files).find(path=>path.startsWith('/entry.'))!
      const result=await kernel.runModule(entry,{webAPIs:true,onOutput:(_level,text)=>{
        if(text.trim()==='ready')edit=kernel.writeText('/created.mjs','export default 42')
      }})
      await edit;return result
    }finally{kernel.close()}
  },files)
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe(expected[name])
})

test('runtime modules | authority, interruption, failed imports, and fresh execution',async({page})=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/write.cjs':`require('node:fs').writeFileSync('/denied','no')`,
      '/loop.cjs':`while(true){}`,
      '/bad.mjs':`export const = 1`,
      '/dynamic.mjs':`await import('./bad.mjs')`,
      '/recover.cjs':`console.log(42)`,
      '/esm.cjs':`require('./await.mjs')`,
      '/await.mjs':`await 0;export default 1`,
    })
    try{
      const runs=[];for(const entry of ['/write.cjs','/loop.cjs','/dynamic.mjs','/esm.cjs']){
        runs.push(await kernel.runModule(entry,{writable:false,timeoutMs:1000}))
        runs.push(await kernel.runModule('/recover.cjs'))
      }
      return {runs,files:Object.keys((await kernel.snapshot()).files)}
    }finally{kernel.close()}
  })
  expect(results.files).not.toContain('/denied')
  const messages=[/read-only/,/timed out|interrupted/,/unexpected|syntax/i,/not implemented/]
  for(let index=0;index<messages.length;index++){
    expect(results.runs[index*2].exitCode).toBe(1)
    expect(results.runs[index*2].stderr).toMatch(messages[index])
    expect(results.runs[index*2+1].exitCode).toBe(0)
    expect(results.runs[index*2+1].stdout.trim()).toBe('42')
  }
})
