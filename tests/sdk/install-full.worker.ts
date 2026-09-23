import {installProject} from '../../src/npm/project'
import {WorkspaceFiles} from '../../src/sandbox/files'

// Diagnostic only: use the real complete project installer, including its
// planner, staging and package cache. No SDK kernel, VM or native API wrappers.
let started=false
self.onmessage=async event=>{
  if(started)return
  started=true
  const counters=new Int32Array(event.data.buffer)
  Atomics.store(counters,0,1)
  const timer=setInterval(()=>Atomics.add(counters,1,1),1000)
  try{
    const files=new WorkspaceFiles(event.data.project,128*1024*1024,16384)
    Atomics.store(counters,2,1)
    const startedAt=performance.now()
    const result=await installProject(files,{cwd:'/project',ignoreScripts:true})
    Atomics.store(counters,2,2)
    const snapshot=files.snapshot()
    const paths=Object.keys(snapshot.files)
    const evidence={result,startedAt,completedAt:performance.now(),fileCount:paths.length,
      byteCount:Object.values(snapshot.files).reduce((total,bytes)=>total+bytes.byteLength,0),
      vitePresent:files.existsSync('/project/node_modules/vite/package.json'),
      lockUnchanged:new TextDecoder().decode(files.readFileSync('/project/package-lock.json'))===event.data.project['/project/package-lock.json']}
    Atomics.store(counters,3,1)
    postMessage({done:true,...evidence})
  }catch(error){
    Atomics.store(counters,2,3)
    Atomics.store(counters,3,1)
    postMessage({done:true,error:String(error),at:performance.now()})
  }finally{clearInterval(timer)}
}
