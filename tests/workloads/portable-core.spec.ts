import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const cases:Record<string,string>={
  'querystring parsing, malformed UTF-8, and prototype keys':`
    import qs from 'node:querystring';
    const inputs=['','a=3&a=7','__proto__=value&constructor=x&toString=y','a+b=c+d','%E0%A4%A=x%FF','a==b&&empty=&bare','&&a=1&&','a%26b=c%3Dd'];
    const results=inputs.map(value=>{const parsed=qs.parse(value);return [parsed,Object.getPrototypeOf(parsed)===null,qs.unescape(value,true),qs.unescapeBuffer(value,true).toString('hex')]});
    results.push(qs.parse('a==3||a==7||b==x','||','=='),qs.parse('a=1&b=2&c=3','&','=',{maxKeys:2}));
    results.push(qs.parse('a+b=c%20d','&','=',{decodeURIComponent:value=>'['+decodeURIComponent(value)+']'}));
    results.push(qs.parse('a=%E0%A4%A','&','=',{decodeURIComponent(){throw Error('decode')}}));
    let seed=7;for(let i=0;i<100;i++){let value='';for(let j=0;j<24;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;value+='ab=&%+01F'[seed%9]}results.push(qs.parse(value))}
    console.log(JSON.stringify(results));`,
  'querystring encoding, custom codecs, and aliases':`
    import qs,{parse,stringify} from 'node:querystring';
    const input={text:'hello 🦊',array:[3,7],empty:[],boolean:true,big:123n,nan:NaN,large:1e21,object:{},nil:null};
    const results=[qs.stringify(input),qs.stringify(input,'||','=='),qs.stringify({a:'value'},'&','=',{encodeURIComponent:value=>'['+value+']'}),qs.parse===qs.decode,qs.encode===qs.stringify,parse===qs.parse,stringify===qs.stringify];
    for(const value of ["!'()*-._~",'a/b?c#d','é🦊','\\ud800',null,42,123n]){
      try{results.push(qs.escape(value))}catch(error){results.push([error.name,error.code])}
    }
    const original=qs.escape;qs.escape=value=>'changed'+value;results.push(qs.stringify({a:'b'}));qs.escape=original;
    console.log(JSON.stringify(results));`,
  'POSIX and Windows path operations match Node':`
    import path from 'node:path';import posix from 'node:path/posix';import win32 from 'node:path/win32';
    const inputs=['','/','//','foo/../bar/','a\\\\b\\\\..\\\\c','C:\\\\a\\\\..\\\\b.txt','C:relative','\\\\\\\\server\\\\share\\\\a','\\\\\\\\?\\\\C:\\\\a','a.tar.gz','.hidden','..','a...','/a/./b/../c','CON:folder','/🦊/é.js'];
    const results=[path===posix,path.posix===posix,path.win32===win32,win32.posix===posix,win32.win32===win32];
    for(const api of [posix,win32])for(const value of inputs){
      results.push([api.normalize(value),api.dirname(value),api.basename(value),api.basename(value,'.txt'),api.extname(value),api.isAbsolute(value),api.parse(value),api.format(api.parse(value)),api.join(value,'..','next'),api.resolve(value),api.relative(api.resolve(value),api.resolve('other')),api.toNamespacedPath(value)]);
    }
    for(const api of [posix,win32])results.push(api.format({dir:'folder',name:'file',ext:'txt'}));
    console.log(JSON.stringify(results));`,
  'path validation and randomized normalization':`
    import {posix,win32} from 'node:path';const results=[];
    for(const api of [posix,win32]){
      for(const method of ['normalize','basename','dirname','extname','parse','isAbsolute','resolve','join','relative'])for(const value of [null,3,{},[]]){
        try{api[method](value,'x');results.push('unexpected')}catch(error){results.push(error.code)}
      }
      const alphabet='abc./\\\\:';let seed=42;for(let i=0;i<150;i++){let value='';for(let j=0;j<20;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;value+=alphabet[seed%alphabet.length]}results.push([api.normalize(value),api.parse(value),api.relative(value,'other')])}
    }
    console.log(JSON.stringify(results));`,
}
for(const [name,code] of Object.entries(cases))for(const execution of ['modules','bundle'] as const)test('Portable core | '+execution+' | '+name,async({page})=>{
  const reference=spawnSync(process.execPath,['--input-type=module'],{input:'process.chdir("/");\n'+code,encoding:'utf8',timeout:10000,maxBuffer:1024*1024})
  expect(reference.status,reference.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({code,execution})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':code})
    try{return await (execution==='modules'?kernel.runModule('/entry.mjs'):kernel.run('/entry.mjs'))}finally{kernel.close()}
  },{code,execution})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(reference.stdout)
})
