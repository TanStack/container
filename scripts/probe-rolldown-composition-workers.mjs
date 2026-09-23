import {writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const fixture=resolve('fixtures/vite-rolldown-wasm')
const mode=process.argv[2]
if(!['sequential','concurrent'].includes(mode)){
  const results=[]
  for(const mode of ['sequential','concurrent']){
    const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),mode],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:resolve(fixture,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')}})
    const line=child.stdout.split('\n').findLast(line=>line.startsWith('RESULT:'))
    results.push({mode,status:child.status,error:child.error?.message,result:line?JSON.parse(line.slice(7)):undefined,stderr:child.stderr.slice(0,16384)})
  }
  await writeFile('reports/rolldown-composition-native-workers.json',JSON.stringify(results,null,2)+'\n')
  console.log(JSON.stringify(results,null,2))
  process.exitCode=results.every(x=>x.status===0&&x.result?.activeAfterCleanup===0)?0:1
}else{
  const began=performance.now(),live=new Set(),evidence={mode,created:0,exited:0,peak:0,events:[],results:[]}
  const record=(type,detail={})=>{if(evidence.events.length<64)evidence.events.push({type,atMs:performance.now()-began,active:live.size,...detail})}
  const guard=setTimeout(()=>{evidence.deadline=true;console.log('RESULT:'+JSON.stringify(evidence));process.exit(124)},14000)
  try{
    const workerModule=(await import('node:worker_threads')).default
    const {syncBuiltinESMExports}=await import('node:module'),OriginalWorker=workerModule.Worker
    workerModule.Worker=class extends OriginalWorker{
      constructor(...args){super(...args);const creation=++evidence.created;live.add(this);evidence.peak=Math.max(evidence.peak,live.size);record('created',{creation});this.once('exit',code=>{live.delete(this);evidence.exited++;record('exit',{creation,code})})}
    }
    syncBuiltinESMExports()
    const {transformSync}=await import(pathToFileURL(resolve(fixture,'node_modules/rolldown/dist/utils-index.mjs')).href)
    const {oxcRuntimePlugin}=await import(pathToFileURL(resolve(fixture,'node_modules/rolldown/dist/experimental-index.mjs')).href)
    const plugin=oxcRuntimePlugin(),handler=typeof plugin.transform==='function'?plugin.transform:plugin.transform.handler
    record('imported')
    const run=async i=>{record('start',{i});const filename='/project/input-'+i+'.ts',code='export const value: number = '+(40+i)+';';const first=await handler.call({},code,filename,{ssr:false,moduleType:'ts'});const result=transformSync(filename,first?.code??code,{lang:'ts',sourcemap:true});record('done',{i});return {code:result.code,errors:result.errors}}
    if(mode==='sequential')for(let i=0;i<3;i++)evidence.results.push(await run(i))
    else evidence.results=await Promise.all([0,1,2].map(run))
    evidence.activeAfterTransforms=live.size
  }catch(error){evidence.failure={name:error.name,message:error.message}}
  finally{await Promise.allSettled([...live].map(worker=>worker.terminate()));evidence.activeAfterCleanup=live.size;clearTimeout(guard)}
  console.log('RESULT:'+JSON.stringify(evidence));process.exitCode=evidence.failure?1:0
}

