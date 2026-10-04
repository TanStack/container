export const nativeInheritedInputBytes=new Uint8Array([0,128,255,10,65])
export const nativeInheritedLargeInputBytes=Uint8Array.from({length:4*1024*1024},(_,index)=>index%256)
export const nativeInheritedInputFiles={
  '/app/input.bin':nativeInheritedInputBytes,
  '/app/input-large.bin':nativeInheritedLargeInputBytes,
  '/app/input-child.cjs':`const chunks=[];process.stdin.on('data',bytes=>chunks.push(bytes));process.stdin.on('end',()=>console.log(Buffer.concat(chunks).toString('hex')));`,
  '/app/input-parent.cjs':`const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['input-child.cjs'],{stdio:['inherit','pipe','pipe']});
let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.pipe(process.stderr);
child.on('error',error=>{console.error(error);process.exitCode=1});
child.on('close',code=>{console.log(JSON.stringify({code,stdinNull:child.stdin===null,output:output.trim()}));if(code)process.exitCode=1});`,
  '/app/input-nested.cjs':`const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['input-parent.cjs'],{stdio:'inherit'});
child.on('error',error=>{console.error(error);process.exitCode=1});child.on('close',code=>process.exitCode=code);`,
}
export const nativeInheritedInputExpected={code:0,stdinNull:true,output:'0080ff0a41'}
nativeInheritedInputFiles['/app/input-large-parent.cjs']=nativeInheritedInputFiles['/app/input-parent.cjs'].replace('input-child.cjs','input-large-child.cjs')
nativeInheritedInputFiles['/app/input-large-child.cjs']=`let length=0,sum=0;process.stdin.on('data',bytes=>{
length+=bytes.length;for(const value of bytes)sum+=value;
process.stdin.pause();setTimeout(()=>process.stdin.resume(),5);
});process.stdin.on('end',()=>console.log(JSON.stringify({length,sum})));`
export const nativeInheritedLargeInputExpected={code:0,stdinNull:true,output:JSON.stringify({length:4*1024*1024,sum:534773760})}
nativeInheritedInputFiles['/app/input-competing-child.cjs']=`let length=0,sum=0,first=true;
process.on('message',message=>{if(message==='go')process.stdin.resume()});
process.stdin.on('data',bytes=>{length+=bytes.length;for(const value of bytes)sum+=value;
if(first){first=false;process.stdin.pause();process.send({ready:true})}});
process.stdin.on('end',()=>process.send({length,sum},()=>process.disconnect()));`
nativeInheritedInputFiles['/app/input-competing-parent.cjs']=`const {fork}=require('node:child_process');
const child=fork('./input-competing-child.cjs',[],{execArgv:[],stdio:['inherit','pipe','pipe','ipc']});
child.stdout.resume();child.stderr.pipe(process.stderr);
let length=0,sum=0,childResult,first=true,parentEnded=false;
child.on('message',message=>{
if(message.ready){
process.stdin.on('data',bytes=>{length+=bytes.length;for(const value of bytes)sum+=value;
if(first){first=false;process.stdin.pause();child.send('go',()=>process.stdin.resume())}});
process.stdin.on('end',()=>parentEnded=true);
}else childResult=message;
});
child.on('error',error=>{console.error(error);process.exitCode=1});
child.on('close',code=>console.log(JSON.stringify({code,parentEnded,parentRead:length>0,childRead:childResult.length>0,length:length+childResult.length,sum:sum+childResult.sum})));`
export const nativeInheritedCompetingExpected={code:0,parentEnded:true,parentRead:true,childRead:true,length:4*1024*1024,sum:534773760}
nativeInheritedInputFiles['/app/input-waiting-child.cjs']=`process.stdin.on('data',()=>{});setImmediate(()=>process.send('waiting'));`
nativeInheritedInputFiles['/app/input-cancel-parent.cjs']=`const {fork,spawn}=require('node:child_process');
const trace=(...values)=>{if(process.env.NATIVE_INPUT_CANCEL_TRACE==='1')console.error('input-cancel',...values)};
trace('parent-start');
const waiting=fork('./input-waiting-child.cjs',[],{execArgv:[],stdio:['inherit','pipe','pipe','ipc']});
waiting.on('spawn',()=>trace('waiting-spawn'));waiting.on('exit',(code,signal)=>trace('waiting-exit',code,signal));
waiting.stdout.on('end',()=>trace('waiting-stdout-end'));waiting.stderr.on('end',()=>trace('waiting-stderr-end'));
waiting.stdout.resume();waiting.stderr.pipe(process.stderr);
waiting.on('error',error=>{console.error(error);process.exitCode=1});
waiting.once('message',()=>{trace('waiting-message');waiting.kill('SIGTERM')});
waiting.once('close',(cancelCode,cancelSignal)=>{
trace('waiting-close');
const child=spawn(process.execPath,['input-child.cjs'],{stdio:['inherit','pipe','pipe']});
let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.pipe(process.stderr);
child.on('error',error=>{console.error(error);process.exitCode=1});
child.on('close',code=>{trace('replacement-close');console.log(JSON.stringify({cancelCode,cancelSignal,code,output:output.trim()}))});
console.log('READY');
});`
export const nativeInheritedCancelledExpected={cancelCode:null,cancelSignal:'SIGTERM',code:0,output:'0080ff0a41'}
nativeInheritedInputFiles['/app/input-fork-child.cjs']=`const chunks=[];process.stdin.on('data',bytes=>chunks.push(bytes));
process.stdin.on('end',()=>{console.log(process.argv[2]+'-out');console.error(process.argv[2]+'-err');process.send(Buffer.concat(chunks).toString('hex'),()=>process.disconnect())});`
nativeInheritedInputFiles['/app/input-fork-parent.cjs']=`const {fork}=require('node:child_process');
(async()=>{
const results=[];
for(const [name,options] of [['default',{}],['silent',{silent:true}],['explicit',{silent:true,stdio:'inherit'}]]){
const child=fork('./input-fork-child.cjs',[name],{execArgv:[],...options});
const pipes=[child.stdin!==null,child.stdout!==null,child.stderr!==null];
if(pipes.some(value=>value!==(name==='silent')))throw Error('Wrong fork stdio defaults for '+name);
let message,stdout='',stderr='';child.stdout?.on('data',bytes=>stdout+=bytes);child.stderr?.on('data',bytes=>stderr+=bytes);
child.on('message',value=>message=value);
const closed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code))});
child.stdin?.end(Buffer.from([0,128,255,10,65]));
const code=await closed;results.push({name,pipes,code,message,stdout:stdout.trim(),stderr:stderr.trim()});
}
console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);process.exitCode=1});`
export const nativeForkDefaultExpected=[
  {name:'default',pipes:[false,false,false],code:0,message:'0080ff0a41',stdout:'',stderr:''},
  {name:'silent',pipes:[true,true,true],code:0,message:'0080ff0a41',stdout:'silent-out',stderr:'silent-err'},
  {name:'explicit',pipes:[false,false,false],code:0,message:'',stdout:'',stderr:''},
]
