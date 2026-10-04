export const nativeChildAbortFiles={
  '/app/package.json':'{"type":"module"}',
  '/app/abort-child.js':'console.log("ready");setInterval(()=>{},1000);',
  '/app/abort-finish.js':'console.log("done");',
  '/app/abort-main.js':`import {spawn,fork,execFile} from 'node:child_process';import {promisify} from 'node:util';import {once} from 'node:events';import {writeFileSync} from 'node:fs';
const results=[];
for(const mode of ['spawn-before','spawn-running','fork-running']){
 const controller=new AbortController(),reason=Error(mode);if(mode==='spawn-before')controller.abort(reason);
 const child=mode==='fork-running'?fork('./abort-child.js',[],{silent:true,signal:controller.signal}):spawn(process.execPath,['./abort-child.js'],{signal:controller.signal});
 const errors=[];child.on('error',error=>errors.push({name:error.name,code:error.code,causeMatches:error.cause===reason}));
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 if(mode!=='spawn-before')child.stdout.once('data',()=>controller.abort(reason));
 child.stdout.resume();child.stderr.resume();const status=await closed;
 results.push({mode,...status,killed:child.killed,errors});
}
{
 const controller=new AbortController(),reason=Error('callback');let calls=0;
 const result=await new Promise(resolve=>{
  const child=execFile(process.execPath,['./abort-child.js'],{signal:controller.signal},(error,stdout)=>{calls++;resolve({mode:'callback',name:error.name,code:error.code,causeMatches:error.cause===reason,stdout})});
  child.stdout.once('data',()=>controller.abort(reason));
 });
 await new Promise(resolve=>setTimeout(resolve,20));results.push({...result,calls});
}
{
 const controller=new AbortController(),reason=Error('promise');controller.abort(reason);
 const promise=promisify(execFile)(process.execPath,['./abort-child.js'],{signal:controller.signal});
 try{await promise;throw Error('Abort resolved')}catch(error){results.push({mode:'promise',name:error.name,code:error.code,causeMatches:error.cause===reason,hasChild:!!promise.child})}
}
{
 const child=spawn(process.execPath,['./abort-child.js'],{timeout:150});let errors=0;child.on('error',()=>errors++);
 child.stdout.resume();child.stderr.resume();const [code,signal]=await once(child,'close');results.push({mode:'timeout',code,signal,killed:child.killed,errors});
}
{
 const controller=new AbortController(),child=spawn(process.execPath,['./abort-finish.js'],{signal:controller.signal});let errors=0;
 child.on('error',()=>errors++);child.stdout.resume();child.stderr.resume();const [code,signal]=await once(child,'close');
 controller.abort(Error('late'));await new Promise(resolve=>setTimeout(resolve,20));results.push({mode:'after-exit',code,signal,killed:child.killed,errors});
}
writeFileSync('abort-result.json',JSON.stringify(results));`,
}
export const nativeChildAbortExpected=[
  ...['spawn-before','spawn-running','fork-running'].map(mode=>({mode,code:null,signal:'SIGTERM',killed:true,errors:[{name:'AbortError',code:'ABORT_ERR',causeMatches:true}]})),
  {mode:'callback',name:'AbortError',code:'ABORT_ERR',causeMatches:true,stdout:'ready\n',calls:1},
  {mode:'promise',name:'AbortError',code:'ABORT_ERR',causeMatches:true,hasChild:true},
  {mode:'timeout',code:null,signal:'SIGTERM',killed:true,errors:0},
  {mode:'after-exit',code:0,signal:null,killed:false,errors:0},
]
