import {fork} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import v8 from 'node:v8'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Worker,MessageChannel} from 'node:worker_threads'
const channel=new MessageChannel()
if(process.argv.includes('--trace-modules'))process.env.NATIVE_MODULE_TRACE='1'
const directory=mkdtempSync(join(tmpdir(),'rpc-module-'))
writeFileSync(join(directory,'package.json'),JSON.stringify({type:'module',imports:{'#scratch':'./private-value.mjs','#common':{import:'./wrong.cjs',require:'./relative-data.cjs'},'#blocked':{require:null,default:'./relative-data.cjs'},'#path':'path'}}))
writeFileSync(join(directory,'private-value.mjs'),'import path from "#path";if(path.join("a","b")!=="a/b")throw Error("Private builtin failed");export default 44')
mkdirSync(join(directory,'node_modules','scratch-package'),{recursive:true})
writeFileSync(join(directory,'node_modules','scratch-package','package.json'),JSON.stringify({exports:{'.':{node:'./node.mjs',default:'./fallback.mjs'}}}))
writeFileSync(join(directory,'node_modules','scratch-package','node.mjs'),'export default 45')
writeFileSync(join(directory,'node_modules','scratch-package','fallback.mjs'),'export default -1')
writeFileSync(join(directory,'relative-value.mjs'),'export default 42')
writeFileSync(join(directory,'relative-value.cjs'),'let blocked=false;try{require("#blocked")}catch{blocked=true}if(!blocked)throw Error("Blocked condition fell through");module.exports=require("#common")')
writeFileSync(join(directory,'wrong.cjs'),'module.exports=-1')
writeFileSync(join(directory,'relative-data.cjs'),'module.exports=43')
writeFileSync(join(directory,'relative-worker.mjs'),"import {parentPort} from 'node:worker_threads';import {createRequire} from 'node:module';import answer from './relative-value.mjs';import common from './relative-value.cjs';import privateValue from '#scratch';import packageValue from 'scratch-package';const require=createRequire(import.meta.url);if(answer!==42||common!==43||privateValue!==44||packageValue!==45||require('./relative-data.cjs')!==43)throw Error('Scratch module import failed');parentPort.postMessage(process.cwd());parentPort.close()")
const originalCwd=process.cwd()
process.chdir(directory)
const relativeWorker=new Worker('./relative-worker.mjs')
const relativeExit=new Promise((resolve,reject)=>{relativeWorker.once('exit',resolve);relativeWorker.once('error',reject)})
const relativeMessage=new Promise((resolve,reject)=>{relativeWorker.once('message',resolve);relativeWorker.once('error',reject)})
const [relativeCwd,relativeCode]=await Promise.all([relativeMessage,relativeExit])
if(relativeCwd!==process.cwd()||relativeCode!==0)throw Error('Relative scratch worker failed')
const data={port:channel.port1,again:channel.port1,expectedCwd:process.cwd()}
data.self=data
const worker=new Worker(new URL('./native-worker-port-child.mjs',import.meta.url),{workerData:data,transferList:[channel.port1]})
const workerExit=new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)})
const firstReply=new Promise(resolve=>channel.port2.once('message',resolve))
const reverseReply=new Promise((resolve,reject)=>worker.once('message',({port})=>{
  try{process.chdir(originalCwd);port.once('message',value=>{port.close();resolve(value)});port.postMessage({value:11,cwd:process.cwd()})}catch(error){reject(error)}
}))
channel.port2.postMessage(2)
if(await firstReply!==5||await reverseReply!==12)throw Error('Transferred worker port returned the wrong result')
channel.port2.close()
if(await workerExit!==0)throw Error('Transferred worker failed')
process.chdir(originalCwd)
const {c:createBirpc}=await import(/* @vite-ignore */ new URL('./chunks/index.B521nVV-.js',import.meta.resolve('vitest')).href)
const child=fork(fileURLToPath(new URL('./native-birpc-child.mjs',import.meta.url)),[],{serialization:'advanced',stdio:'pipe',cwd:directory})
const exit=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)})
child.stdout.on('data',bytes=>process.stdout.write(bytes))
child.stderr.on('data',bytes=>process.stderr.write(bytes))
createBirpc({parentDirectory:()=>process.cwd(),directory:()=>directory,add:(a,b)=>Promise.resolve(a+b),collections:()=>{
  const date=new Date(42),map=new Map(),set=new Set([date,map]),pattern=/你好[abc]+/dgimsuy
  map.set(map,set)
  const view=new Int16Array([123,-456]),data=new DataView(new Uint8Array([9,1,2,9]).buffer,1,2)
  const buffer=new Uint8Array([1,2,255]).buffer
  return {date,again:date,map,set,bigint:-(2n**120n),pattern,patternAgain:pattern,view,viewAgain:view,data,buffer,bufferAgain:buffer}
},fetch:id=>Promise.resolve({code:id==='/app/rpc-evaluated.mjs'?'__vite_ssr_exports__.default = await Promise.resolve(42)':'export default 42',externalize:undefined,map:null}),fetchFile:()=>{
  const id=join(directory,'module.js')
  writeFileSync(id,'__vite_ssr_exports__.default = await Promise.resolve(43)')
  return {id}
}}, {
  serialize:v8.serialize,deserialize:bytes=>v8.deserialize(Buffer.from(bytes)),
  post:bytes=>child.send(bytes),on:callback=>child.on('message',callback),timeout:2000,
})
let code
try{code=await exit}finally{rmSync(directory,{recursive:true})}
if(code!==0)throw Error('RPC child failed: '+code)
console.log('rpc exit:0')
