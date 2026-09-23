import {spawn} from 'node:child_process'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {setTimeout as delay} from 'node:timers/promises'

const phases=[]
const kernel=process.argv.includes('--kernel')
async function run(name,args,env=process.env){
  const started=Date.now()
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{stdio:'inherit',env})
    child.once('error',reject)
    child.once('exit',code=>resolve(code??1))
  })
  phases.push({name,code,durationMs:Date.now()-started})
  return code
}

let server,code=1,error,artifacts
try{
  if(!process.env.npm_execpath)throw Error('Run this with npm run probe:desktop')
  code=await run('build',[process.env.npm_execpath,'run','build'])
  if(code)throw Error('Build failed')
  artifacts=Object.fromEntries(['quickjs-als','quickjs-als-asyncify','kernel-runtime','vm-web-apis'].map(name=>[name,JSON.parse(readFileSync('dist/'+name+'/build.json','utf8'))]))
  code=await run('desktop lifecycle',['node_modules/@playwright/test/cli.js','test','--config=playwright.desktop.config.ts',kernel?'worker-kernel.spec.ts':'lifecycle.spec.ts'],
    {...process.env,SANDBOX_DESKTOP_BACKEND:kernel?'kernel':'combined'})
  if(code)throw Error('Desktop lifecycle failed')
  if(process.platform!=='darwin')throw Error('Memory gate is not implemented on this OS; desktop gate is incomplete')
  const base='http://127.0.0.1:4188'
  server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4188','--strictPort'],{stdio:['ignore','pipe','inherit']})
  let serverError
  server.once('error',e=>{serverError=e})
  server.once('exit',()=>{serverError??=Error('Owned preview server exited')})
  let ready=false
  server.stdout.on('data',data=>{
    process.stdout.write(data)
    if(data.toString().includes(base))ready=true
  })
  for(let i=0;i<100;i++){
    if(serverError)throw serverError
    if(ready)break
    await delay(100)
  }
  if(!ready)throw Error('Preview server did not start')
  if(serverError)throw serverError
  if(!(await fetch(base+'/sandbox.html',{signal:AbortSignal.timeout(2000)})).ok)throw Error('Preview health check failed')
  const memoryEnv={...process.env,MEMORY_LIMIT_MIB:'2048',MEMORY_IDLE_MS:'60000',ENGINE_PROFILE:'',DIAGNOSTIC_GC:'',CPU_SAMPLE:'',MEMORY_MAP:''}
  if(!kernel){
    code=await run('WebKit memory stress',['scripts/probe-memory.mjs',base,'stress','desktop-gate'],memoryEnv)
    if(code)throw Error('WebKit memory gate failed')
  }
  code=await run('WebKit full workflow memory',['scripts/probe-memory.mjs',base,kernel?'kernel-repeat':'combined',kernel?'kernel-gate':'desktop-workflow'],memoryEnv)
  if(code)throw Error('WebKit workflow memory gate failed')
}catch(e){error=String(e);code=1;console.error(error)}finally{
  server?.kill('SIGTERM')
  mkdirSync('reports',{recursive:true})
  writeFileSync(kernel?'reports/kernel-gate.json':'reports/desktop-gate.json',JSON.stringify({generatedAt:new Date().toISOString(),
    backend:kernel?'worker-owned':'combined-asyncify',status:code?'failed':'local-gates-passed',platform:process.platform,artifacts,phases,error:error??null,
    unverified:['Safari','Edge','other operating systems','physical phones'],
  },null,2)+'\n')
}
process.exitCode=code
