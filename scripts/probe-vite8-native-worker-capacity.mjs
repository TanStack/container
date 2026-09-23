import {readFile,mkdtemp,mkdir,writeFile,symlink} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const fixture=resolve('fixtures/vite-rolldown-wasm')
if(!process.argv.includes('--child')){
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--child'],{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024,env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:join(fixture,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')}})
  const line=child.stdout?.split('\n').findLast(line=>line.startsWith('VITE_WORKERS_RESULT:'))
  const evidence={scope:'Native installed Vite WASM binding, rendered-preview fixture HTTP requests, worker instance lifetime, not a memory-limit test',status:child.status,signal:child.signal,error:child.error?.message,result:line?JSON.parse(line.slice('VITE_WORKERS_RESULT:'.length)):undefined,stderr:child.stderr.slice(0,32768)}
  await writeFile(resolve('reports/vite8-native-worker-capacity.json'),JSON.stringify(evidence,null,2)+'\n')
  console.log(JSON.stringify(evidence,null,2))
  process.exitCode=child.status===0&&evidence.result?.closed&&evidence.result?.activeAfterCleanup===0?0:1
}else{
  const started=performance.now(),live=new Set(),evidence={events:[],responses:[],created:0,peak:0};let server
  const record=(type,detail={})=>{if(evidence.events.length<128)evidence.events.push({type,atMs:performance.now()-started,active:live.size,...detail})}
  // The binding unrefs its workers. Keep cleanup observed until it settles,
  // while the parent independently enforces the overall15second deadline.
  const guard=setTimeout(()=>{evidence.deadline=true;console.log('VITE_WORKERS_RESULT:'+JSON.stringify(evidence));process.exit(124)},14000)
  try{
    const workerModule=(await import('node:worker_threads')).default
    const {syncBuiltinESMExports}=await import('node:module'),OriginalWorker=workerModule.Worker
    workerModule.Worker=class extends OriginalWorker{
      constructor(...args){
        super(...args)
        const creation=++evidence.created;live.add(this);evidence.peak=Math.max(evidence.peak,live.size)
        record('worker-created',{creation,file:String(args[0])})
        this.once('exit',code=>{live.delete(this);record('worker-exit',{creation,code})})
      }
    }
    syncBuiltinESMExports()
    evidence.versions={}
    for(const name of ['vite','@rolldown/binding-wasm32-wasi'])evidence.versions[name]=JSON.parse(await readFile(join(fixture,'node_modules',name,'package.json'),'utf8')).version
    const root=await mkdtemp(join(tmpdir(),'vite8-worker-capacity-'));evidence.root=root
    await mkdir(join(root,'app'))
    await symlink(join(fixture,'node_modules'),join(root,'node_modules'),'dir')
    await writeFile(join(root,'app/index.html'),'<html><head><title>Vite preview fixture</title></head><body><button id="count"></button><p id="message"></p><script type="module" src="/main.ts"></script></body></html>')
    await writeFile(join(root,'app/message.ts'),'export const message: string = "first version";')
    await writeFile(join(root,'app/main.ts'),`import {message} from './message';let count: number=42;const button=document.querySelector('#count');button.textContent=String(count);button.onclick=()=>button.textContent=String(++count);document.querySelector('#message').textContent=message;if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);`)
    const {createServer}=await import(pathToFileURL(join(fixture,'node_modules/vite/dist/node/index.js')).href)
    record('vite-imported')
    server=await createServer({root:join(root,'app'),configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0,strictPort:true}})
    await server.listen();record('listening')
    const base='http://127.0.0.1:'+server.httpServer.address().port
    const request=async path=>{
      const response=await fetch(base+path),body=await response.text()
      evidence.responses.push({path,status:response.status,bytes:Buffer.byteLength(body)});record('response',{path,status:response.status})
      if(response.status!==200)throw Error('HTTP '+response.status+' '+path)
    }
    await request('/')
    await Promise.all([request('/@vite/client'),request('/main.ts')])
    await request('/message.ts')
    evidence.activeAfterRequests=live.size
  }catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}
  finally{
    if(server)try{await server.close();evidence.closed=true;record('server-closed')}catch(error){evidence.closeError=String(error)}
    await Promise.allSettled([...live].map(worker=>worker.terminate()))
    evidence.activeAfterCleanup=live.size;record('cleanup-finished')
    clearTimeout(guard)
  }
  console.log('VITE_WORKERS_RESULT:'+JSON.stringify(evidence))
  process.exit(evidence.failure||evidence.closeError?1:0)
}
