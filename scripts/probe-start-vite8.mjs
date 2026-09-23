import {readFile,mkdtemp,mkdir,copyFile,symlink} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const fixture=resolve('fixtures/start-vite8-wasm')
if(!process.argv.includes('--child')){
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--child'],{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024,env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:join(fixture,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')}})
  const line=child.stdout?.split('\n').findLast(line=>line.startsWith('START_VITE8_RESULT:'))
  const evidence={scope:'Native unchanged Start app config, Vite8 and declared WASM dependency profile; SSR only, not hydration',status:child.status,signal:child.signal,error:child.error?.message,result:line?JSON.parse(line.slice('START_VITE8_RESULT:'.length)):undefined,stdout:child.stdout,stderr:child.stderr}
  console.log(JSON.stringify(evidence,null,2))
  process.exitCode=child.status===0&&evidence.result?.closed===true?0:1
}else{
  const evidence={stages:[],responses:[],versions:{}};let server
  try{
    const manifest=JSON.parse(await readFile(join(fixture,'package.json'),'utf8'));evidence.dependencies=manifest.dependencies
    for(const name of ['vite','@tanstack/react-start','@tanstack/react-router','@vitejs/plugin-react'])evidence.versions[name]=JSON.parse(await readFile(join(fixture,'node_modules',name,'package.json'),'utf8')).version
    const root=await mkdtemp(join(tmpdir(),'start-vite8-control-'));evidence.root=root
    // The existing app consists of its config plus four source files.
    for(const file of ['vite.config.ts','src/router.tsx','src/routes/__root.tsx','src/routes/index.tsx','src/routes/about.tsx']){
      const target=join(root,file);await mkdir(dirname(target),{recursive:true});await copyFile(resolve('fixtures/start-basic',file),target)
    }
    await copyFile(join(fixture,'package.json'),join(root,'package.json'))
    const trace=process.env.START_TRACE_HOOKS==='1'
    if(trace)await copyFile(resolve('tests/fixtures/vite-hook-profiler.mjs'),join(root,'vite-hook-profiler.mjs'))
    await symlink(join(fixture,'node_modules'),join(root,'node_modules'),'dir')
    evidence.stages.push('fixture-copied')
    if(process.env.START_TRACE_WORKERS==='1'){
      const workerModule=(await import('node:worker_threads')).default
      const {syncBuiltinESMExports}=await import('node:module')
      const OriginalWorker=workerModule.Worker
      evidence.workerCreations=[];evidence.workerExits=[]
      workerModule.Worker=class extends OriginalWorker{
        constructor(...args){
          const creation=evidence.workerCreations.length+1
          if(creation<=32)evidence.workerCreations.push({creation,file:String(args[0]),asyncWorkers:args[1]?.env?.NAPI_RS_ASYNC_WORK_POOL_SIZE,stack:new Error('worker creation').stack})
          super(...args)
          this.once('exit',code=>{if(evidence.workerExits.length<32)evidence.workerExits.push({creation,code})})
        }
      }
      const {traceWorkerProtocol}=await import('../tests/fixtures/worker-protocol-trace.mjs')
      evidence.workerProtocol=[]
      traceWorkerProtocol(workerModule,row=>evidence.workerProtocol.push(row))
      syncBuiltinESMExports()
    }
    const {createServer}=await import(pathToFileURL(join(fixture,'node_modules/vite/dist/node/index.js')).href)
    evidence.stages.push('vite-imported')
    const plugins=trace?[(await import(pathToFileURL(join(root,'vite-hook-profiler.mjs')).href)).hookProfiler()]:[]
    server=await createServer({root,configFile:join(root,'vite.config.ts'),plugins,logLevel:'silent',server:{host:'127.0.0.1',port:0}})
    evidence.stages.push('server-created');await server.listen();evidence.stages.push('listening')
    const address=server.httpServer.address(),base='http://127.0.0.1:'+address.port
    for(const [path,heading] of [['/','Bare-bones Start'],['/about','Second route']]){
      const response=await fetch(base+path),html=await response.text()
      const row={path,status:response.status,bytes:Buffer.byteLength(html),heading,headingPresent:html.includes(heading),html};evidence.responses.push(row)
      if(response.status!==200||!row.headingPresent)throw Error('SSR failed for '+path)
      if(path==='/'&&(!html.includes('TanStack Start rendered inside the browser runtime.')||!html.includes('Request context: <!-- -->/')))throw Error('Missing async request-context loader output')
    }
    evidence.stages.push('ssr-verified')
  }catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}
  finally{if(server)try{await server.close();evidence.closed=true}catch(error){evidence.closeError={name:error.name,message:error.message}}}
  console.log('START_VITE8_RESULT:'+JSON.stringify(evidence))
  process.exit(evidence.failure||evidence.closeError?1:0)
}
