const {parentPort,workerData}=require('node:worker_threads')
const {createCompilerFilesystem}=require(workerData.adapter)
const pending=new Map(),input=[]
let sequence=0,inputSize=0,outputSize=0,readWaiter
function rpc(op,args,callback){if(pending.size>=64)return callback(Object.assign(Error('Filesystem queue limit'),{code:'EIO'}));const id=++sequence;pending.set(id,callback);parentPort.postMessage({type:'rpc',id,op,args})}
function consume(){if(!readWaiter||!input.length)return;const {buffer,offset,length,callback}=readWaiter;readWaiter=undefined;const chunk=input[0],count=Math.min(length,chunk.length);buffer.set(chunk.subarray(0,count),offset);inputSize-=count;if(count===chunk.length)input.shift();else input[0]=chunk.subarray(count);callback(null,count)}
parentPort.on('message',message=>{
  if(message.type==='stdin'){inputSize+=message.bytes.length;if(inputSize>4*1024*1024)throw Error('Stdin queue limit');input.push(message.bytes);consume()}
  if(message.type==='reply'){const callback=pending.get(message.id);if(!callback)throw Error('Unknown filesystem reply');pending.delete(message.id);callback(message.error?Object.assign(Error(message.error.message),{code:message.error.code}):null,message.value)}
})
const workspaceFS=createCompilerFilesystem((op,args)=>new Promise((resolve,reject)=>rpc(op,args,(error,value)=>error?reject(error):resolve(value))))
globalThis.fs={...workspaceFS,
  writeSync(fd,bytes){if(fd!==1&&fd!==2)throw Error('Unsupported write');outputSize+=bytes.length;if(outputSize>4*1024*1024)throw Error('Output budget exceeded');parentPort.postMessage({type:fd===1?'stdout':'stderr',bytes:new Uint8Array(bytes)});return bytes.length},
  write(fd,buffer,offset,length,position,callback){if(fd!==1&&fd!==2)return workspaceFS.write(fd,buffer,offset,length,position,callback);try{callback(null,this.writeSync(fd,buffer.subarray(offset,offset+length)))}catch(error){callback(error)}},
  read(fd,buffer,offset,length,position,callback){if(fd===0){if(readWaiter)throw Error('Concurrent stdin reads');readWaiter={buffer,offset,length,callback};consume()}else workspaceFS.read(fd,buffer,offset,length,position,callback)},
}
// The Go runtime sees a virtual process, never the launcher's host cwd or env.
globalThis.process={getuid:()=>0,getgid:()=>0,geteuid:()=>0,getegid:()=>0,getgroups:()=>[],pid:1,ppid:0,umask:()=>0,cwd:()=>'/workspace',chdir(){throw Error('Working directory changes are unsupported')}}
globalThis.path=require('node:path').posix
require(workerData.runtime)
const go=new Go()
go.argv=['esbuild',...workerData.args]
go.env={PWD:'/workspace',TMPDIR:'/tmp'}
go.exit=code=>parentPort.postMessage({type:'error',error:'Go exited '+code})
WebAssembly.instantiate(workerData.bytes,go.importObject).then(result=>go.run(result.instance)).catch(error=>parentPort.postMessage({type:'error',error:String(error)}))
