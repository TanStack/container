export const nativeAppForkFiles={
  '/app/app-fork-child.cjs':`process.stdin.on('end',()=>process.send({eof:true},()=>process.disconnect()));process.stdin.resume();`,
  '/app/app-fork-parent.mjs':`import {fork} from 'node:child_process';
let parentInput='';for await(const bytes of process.stdin)parentInput+=bytes;
export const result=await new Promise((resolve,reject)=>{
const child=fork('./app-fork-child.cjs',[],{execArgv:[]});
const pipes=[child.stdin!==null,child.stdout!==null,child.stderr!==null];let message;
child.on('message',value=>message=value);child.on('error',reject);
child.on('close',code=>resolve({pipes,message,code,parentInput,parentTTY:Boolean(process.stdin.isTTY),parentFD:process.stdin.fd}));
});export default {fetch(){return Response.json(result)}};`,
}
export const nativeAppForkExpected={pipes:[false,false,false],message:{eof:true},code:0,parentInput:'',parentTTY:false,parentFD:0}
