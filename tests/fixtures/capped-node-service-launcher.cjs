// Explicit prototype launcher. Disk access is limited to owned staged assets and evidence.
const {Worker}=require('node:worker_threads')
const {readFileSync,writeFileSync}=require('node:fs')
const path=require('node:path')
const root=path.resolve(__dirname,'..')
const {WorkspaceFiles,WorkspaceFileSessions,CompilerWorkspace}=require(path.join(root,'adapter.cjs'))
const seed=JSON.parse(readFileSync(path.join(root,'workspace.json'),'utf8'))
if(Object.keys(seed).length>32||Buffer.byteLength(JSON.stringify(seed))>65536)throw Error('Virtual workspace seed budget exceeded')
const files=new WorkspaceFiles(seed,1024*1024,64)
const sessions=new WorkspaceFileSessions(files),workspace=new CompilerWorkspace(sessions,true)
let traffic=0,stopping,closed=false
const limit=4*1024*1024
function evidence(){
  const snapshot=files.snapshot()
  writeFileSync(path.join(root,'workspace-evidence.json'),JSON.stringify({servicePid:process.pid,closed,descriptors:sessions.descriptors,sessions:sessions.size,files:Object.fromEntries(Object.entries(snapshot.files).map(([name,bytes])=>[name,Buffer.from(bytes).toString('utf8')]))},null,2))
}
const worker=new Worker(path.join(root,'worker.cjs'),{workerData:{bytes:readFileSync(path.join(root,'esbuild.wasm')),runtime:path.join(root,'wasm_exec.js'),adapter:path.join(root,'adapter.cjs'),args:process.argv.slice(2)},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}})
function stop(code=0){return stopping??=(async()=>{
  clearTimeout(deadline);workspace.close();process.stdin.destroy()
  await worker.terminate()
  closed=true;evidence();sessions.close();files.close();process.exitCode=code
})()}
const fail=error=>{console.error(error);void stop(1)}
const deadline=setTimeout(()=>fail(Error('Service prototype exceeded 10 seconds')),10000)
worker.on('message',async message=>{
  if(stopping)return
  if(message.type==='stdout'||message.type==='stderr'){
    traffic+=message.bytes.length;if(traffic>limit)return fail(Error('Service output budget exceeded'))
    evidence()
    ;(message.type==='stdout'?process.stdout:process.stderr).write(message.bytes)
  }else if(message.type==='rpc'){
    let value,err
    try{value=await workspace.call(message.op,message.args)}catch(e){err={code:e.code||'EIO',message:e.message}}
    if(!stopping)worker.postMessage({type:'reply',id:message.id,value,error:err})
  }else if(message.type==='error')fail(Error(message.error))
})
let inputBytes=0
process.stdin.on('data',bytes=>{inputBytes+=bytes.length;if(inputBytes>limit)return fail(Error('Service input budget exceeded'));worker.postMessage({type:'stdin',bytes})})
process.stdin.on('end',()=>void stop())
process.on('SIGTERM',()=>void stop())
worker.on('error',fail)
worker.on('exit',code=>{if(!stopping)void stop(code)})
