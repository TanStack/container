export const nativeExecFileFiles={
  '/app/package.json':'{"type":"module"}',
  '/app/exec-child.js':`const mode=process.argv[2];
if(mode==='text'){process.stdout.write(new Uint8Array([240,159]));process.stdout.write(new Uint8Array([152,128]));process.stderr.write('warning')}
if(mode==='buffer')process.stdout.write(new Uint8Array([255,0,240,159,152,128]));
if(mode==='failure'){process.stdout.write('before failure');process.stderr.write('failure detail');process.exitCode=7}
if(mode==='stdout-limit')process.stdout.write('123456789');
if(mode==='stderr-limit')process.stderr.write('123456789');
if(mode==='timeout')setInterval(()=>{},1000);`,
  '/app/exec-main.js':`import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {Buffer} from 'node:buffer';import {writeFileSync} from 'node:fs';
const results=[];
for(const [mode,options] of [['text',{}],['buffer',{encoding:'buffer'}],['failure',{}],['stdout-limit',{maxBuffer:4}],['stderr-limit',{maxBuffer:4}],['timeout',{timeout:150}]]){
 let calls=0;
 const result=await new Promise(resolve=>execFile(process.execPath,['./exec-child.js',mode],options,(error,stdout,stderr)=>{
  calls++;resolve({mode,error:error?{name:error.name,code:error.code??null,killed:error.killed??null,signal:error.signal??null}:null,
    stdout:Buffer.isBuffer(stdout)?[...stdout]:stdout,stderr:Buffer.isBuffer(stderr)?[...stderr]:stderr,buffer:Buffer.isBuffer(stdout)})
 }));
 await new Promise(resolve=>setTimeout(resolve,20));results.push({...result,calls});
}
const execute=promisify(execFile);const promise=execute(process.execPath,['./exec-child.js','text']);
const value=await promise;let rejection;
try{await execute(process.execPath,['./exec-child.js','failure'])}catch(error){rejection={code:error.code,stdout:error.stdout,stderr:error.stderr}}
results.push({mode:'promise',value,hasChild:!!promise.child,rejection,symbolMatches:promisify.custom===Symbol.for('nodejs.util.promisify.custom')});
writeFileSync('exec-result.json',JSON.stringify(results));`,
}
export const nativeExecFileExpected=[
  {mode:'text',error:null,stdout:'😀',stderr:'warning',buffer:false,calls:1},
  {mode:'buffer',error:null,stdout:[255,0,240,159,152,128],stderr:[],buffer:true,calls:1},
  {mode:'failure',error:{name:'Error',code:7,killed:false,signal:null},stdout:'before failure',stderr:'failure detail',buffer:false,calls:1},
  {mode:'stdout-limit',error:{name:'RangeError',code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',killed:null,signal:null},stdout:'1234',stderr:'',buffer:false,calls:1},
  {mode:'stderr-limit',error:{name:'RangeError',code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',killed:null,signal:null},stdout:'',stderr:'1234',buffer:false,calls:1},
  {mode:'timeout',error:{name:'Error',code:null,killed:true,signal:'SIGTERM'},stdout:'',stderr:'',buffer:false,calls:1},
  {mode:'promise',value:{stdout:'😀',stderr:'warning'},hasChild:true,rejection:{code:7,stdout:'before failure',stderr:'failure detail'},symbolMatches:true},
]
