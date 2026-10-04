export const evalSource=`require('node:fs').writeFileSync('eval-owned.txt','written');console.log(JSON.stringify({answer:42,args:process.argv.slice(1),execArgv:process.execArgv,argv0Matches:process.argv[0]===process.execPath,commonJS:typeof require==='function'&&typeof module.exports==='object'}));`
export const evalFlags=[['-e',evalSource],['--eval',evalSource],['--eval='+evalSource]]
export const nativeNodeEsmFailuresExpected=[
 {code:0,stdout:'42\n',stderrEmpty:true,syntaxError:false,explicitError:false},
 {code:1,stdout:'',stderrEmpty:false,syntaxError:true,explicitError:false},
 {code:1,stdout:'',stderrEmpty:false,syntaxError:false,explicitError:true},
]
export const nativeNodeEsmExpected=[...Array.from({length:2},()=>({result:{value:42,url:true,require:'undefined',args:['esm argument']},stderr:''})),{result:{value:42,url:true,require:'undefined',args:['-','esm argument']},stderr:''}]
const forkEvalSource=`const child=require('node:child_process').fork('./eval-fork.cjs',[],{silent:true});let text='';child.stdout.on('data',chunk=>text+=chunk);child.on('close',()=>console.log(text.trim()));`
export const nativeNodeEvalFiles={
  '/app/stdin-source.txt':"console.log(JSON.stringify({filename:__filename,dirname:__dirname,id:module.id,moduleFilename:module.filename===process.cwd()+'/[stdin]',args:process.argv.slice(1),value:require('./eval-preload.cjs'),unicode:'☃'}))",
  '/app/package.json':'{"type":"module"}',
  '/app/eval-preload.cjs':'globalThis.__evalPreload=41;',
  '/app/esm-value.mjs':'export const value=42;',
  '/app/esm-source.txt':"import {value} from './esm-value.mjs';await Promise.resolve();console.log(JSON.stringify({value,url:import.meta.url==='file://'+process.cwd()+'/[eval1]',require:typeof require,args:process.argv.slice(1)}))",
  '/app/eval-fork.cjs':`console.log(JSON.stringify({answer:43,noEvalFlags:!process.execArgv.some(flag=>flag==='-e'||flag==='--eval'||flag.startsWith('--eval='))}));`,
  '/app/eval-main.js':`import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import {writeFileSync,readFileSync} from 'node:fs';
const execute=promisify(execFile),results=[];
for(const flags of ${JSON.stringify(evalFlags)}){
 const {stdout,stderr}=await execute(process.execPath,[...flags,'space value']);
 results.push({result:JSON.parse(stdout),stderr,file:readFileSync('eval-owned.txt','utf8')});
}
const identity=await execute(process.execPath,['-e',"console.log(JSON.stringify({filename:__filename,dirname:__dirname,id:module.id,moduleFilename:module.filename===process.cwd()+'/[eval]',main:require.main===module}))"]);
results.push({identity:JSON.parse(identity.stdout),stderr:identity.stderr});
const stdin=await new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['-','space value']);let stdout='',stderr='';
 child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);
 child.on('close',code=>resolve({code,result:JSON.parse(stdout),stderr}));
 const source="console.log(JSON.stringify({filename:__filename,dirname:__dirname,id:module.id,moduleFilename:module.filename===process.cwd()+'/[stdin]',args:process.argv.slice(1),value:require('./eval-preload.cjs'),unicode:'☃'}))";
 const bytes=new TextEncoder().encode(source);for(let i=0;i<bytes.length;i+=7)child.stdin.write(bytes.subarray(i,i+7));child.stdin.end();
});
results.push({stdin});
const preload=await execute(process.execPath,['-r','./eval-preload.cjs','-e','console.log(globalThis.__evalPreload+1)']);
const fork=await execute(process.execPath,['-e',${JSON.stringify(forkEvalSource)}]);
const stdinCases=[];
for(const source of ['', 'const = broken', 'process.exitCode=7;console.log("done")']){
 stdinCases.push(await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['-']);let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);
  child.on('close',(code,signal)=>resolve({code,signal,stdout,syntaxError:stderr.includes('SyntaxError'),stderrEmpty:stderr===''}));
  child.stdin.end(source);
 }));
}
const esmSource="import {value} from './esm-value.mjs';await Promise.resolve();console.log(JSON.stringify({value,url:import.meta.url==='file://'+process.cwd()+'/[eval1]',require:typeof require,args:process.argv.slice(1)}))";
const esm=[];
for(const flags of [['--input-type=module','-e',esmSource],['--input-type','module','-e',esmSource]]){
 const result=await execute(process.execPath,[...flags,'esm argument']);esm.push({result:JSON.parse(result.stdout),stderr:result.stderr});
}
esm.push(await new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['--input-type=module','-','esm argument']);let stdout='',stderr='';
 child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);
 child.on('close',code=>code===0?resolve({result:JSON.parse(stdout),stderr}):reject(Error(stderr)));
 child.stdin.end(esmSource);
}));
const esmFailures=[];
for(const source of ["console.log((await import('./esm-value.mjs')).value)",'export const = broken',"await Promise.reject(Error('owned rejection'))"]){
 esmFailures.push(await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',source]);let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);
  child.on('close',code=>resolve({code,stdout,stderrEmpty:stderr==='',syntaxError:stderr.includes('SyntaxError'),explicitError:stderr.includes('owned rejection')}));
 }));
}
writeFileSync('eval-result.json',JSON.stringify({results,preload,fork:{result:JSON.parse(fork.stdout),stderr:fork.stderr},stdinCases,esm,esmFailures}));`,
}
export const nativeNodeEvalExpected={results:[...evalFlags.map(flags=>({result:{answer:42,args:['space value'],execArgv:flags,argv0Matches:true,commonJS:true},stderr:'',file:'written'})),{identity:{filename:'[eval]',dirname:'.',id:'[eval]',moduleFilename:true,main:false},stderr:''},{stdin:{code:0,result:{filename:'[stdin]',dirname:'.',id:'[stdin]',moduleFilename:true,args:['-','space value'],value:{},unicode:'☃'},stderr:''}}],preload:{stdout:'42\n',stderr:''},fork:{result:{answer:43,noEvalFlags:true},stderr:''},stdinCases:[{code:0,signal:null,stdout:'',syntaxError:false,stderrEmpty:true},{code:1,signal:null,stdout:'',syntaxError:true,stderrEmpty:false},{code:7,signal:null,stdout:'done\n',syntaxError:false,stderrEmpty:true}]}
