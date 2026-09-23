#!/usr/bin/env node
import {spawn} from 'node:child_process'
import {createConnection} from 'node:net'
import {createHash} from 'node:crypto'
import {readFileSync,realpathSync,mkdirSync,existsSync,createWriteStream} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {loadContract,validateRunReport} from '../integrations/tanstack-four-examples/harness.mjs'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const json=path=>JSON.parse(readFileSync(path,'utf8'))
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))

export async function runMatrix(config,ops){
  const preview=await ops.startPreview()
  try{
    await ops.readyPreview(preview)
    for(const example of config.examples){
      const owner=await ops.startOwner(example)
      try{
        await ops.readyOwner(owner,example)
        for(const browser of ['chromium','firefox'])await ops.runCell(example,browser)
      }finally{await ops.stop(owner)}
    }
  }finally{await ops.stop(preview)}
}

export function validateConfig(input){
  const config={...input}
  for(const key of ['site','sourceRepository','artifact','integration','observedCommands'])config[key]=realpathSync(config[key])
  config.output=resolve(config.output)
  if(existsSync(config.output))throw Error('Output directory must be new')
  const contract=loadContract()
  if(!Array.isArray(config.examples)||JSON.stringify(config.examples.map(row=>row.id))!==JSON.stringify(contract.examples.map(row=>row.id)))throw Error('Exactly the four contracted examples in order are required')
  config.examples=config.examples.map(row=>{
    if(!['start','router'].includes(row.library))throw Error('Invalid library')
    return {...row,fixture:realpathSync(row.fixture),adaptations:realpathSync(row.adaptations)}
  })
  const artifact=json(config.artifact)
  if(artifact.packaging!=='split')throw Error('Expected split artifact record')
  for(const [relative,expected] of [['node_modules/@tanstack/browser-sandbox-experimental/package-assets.json',artifact.manifestSHA256],['node_modules/@tanstack/browser-sandbox-runtime-experimental/package-assets.json',artifact.runtimeManifestSHA256]])if(hash(join(config.site,relative))!==expected)throw Error('Installed package identity mismatch')
  for(const file of json(config.integration).files){
    if(file.path.startsWith('/')||file.path.split('/').includes('..'))throw Error('Unsafe integration path')
    if(hash(join(config.site,file.path))!==file.sha256)throw Error('Integration file changed: '+file.path)
  }
  return config
}

async function requireUnusedPort(port){
  await new Promise((resolve,reject)=>{
    const socket=createConnection({host:'127.0.0.1',port})
    socket.once('connect',()=>{socket.destroy();reject(Error('Port already occupied: '+port))})
    socket.once('error',error=>error.code==='ECONNREFUSED'?resolve():reject(error))
    socket.setTimeout(2000,()=>{socket.destroy();reject(Error('Port check timed out: '+port))})
  })
}

export async function main(configPath){
  const config=validateConfig(json(configPath)),artifact=json(config.artifact)
  await requireUnusedPort(4198);await requireUnusedPort(4199)
  mkdirSync(config.output)
  const owned=new Set()
  let interrupted=false
  function launch(command,args,cwd,name,env={}){
    if(interrupted)throw Error('Matrix interrupted')
    const log=createWriteStream(join(config.output,name+'.log'),{flags:'wx'})
    const child=spawn(command,args,{cwd,env:{...process.env,...env},detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']})
    child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false})
    const handle={child,done:null,ended:false}
    handle.done=new Promise((resolve,reject)=>{
      child.once('error',error=>{handle.ended=true;log.end();reject(error)})
      child.once('exit',(code,signal)=>{handle.ended=true;log.end();resolve({code,signal})})
    })
    void handle.done.catch(()=>{})
    owned.add(handle)
    return handle
  }
  async function stop(handle){
    if(!owned.has(handle))return
    if(!handle.ended){
      const signal=value=>{try{process.platform==='win32'?handle.child.kill(value):process.kill(-handle.child.pid,value)}catch(error){if(error.code!=='ESRCH')throw error}}
      signal('SIGTERM')
      await Promise.race([handle.done,sleep(5000)])
      if(!handle.ended){signal('SIGKILL');await handle.done}
    }
    owned.delete(handle)
  }
  async function ready(handle,url,identity=false){
    const deadline=Date.now()+120000
    while(Date.now()<deadline){
      if(interrupted)throw Error('Matrix interrupted')
      if(handle.ended)throw Error('Server exited before readiness: '+url)
      try{
        const response=await fetch(url,{signal:AbortSignal.timeout(3000)})
        if(response.ok){
          if(identity){const value=(await response.json()).identity;if(value?.sdkManifestSHA256!==artifact.manifestSHA256||value?.runtimeManifestSHA256!==artifact.runtimeManifestSHA256||value?.deploymentManifestSHA256!==artifact.deploymentManifestSHA256)throw Error('Owner identity mismatch')}
          return
        }
      }catch(error){if(error.message==='Owner identity mismatch')throw error}
      await sleep(250)
    }
    throw Error('Server readiness timed out: '+url)
  }
  const env={SANDBOX_SDK_MANIFEST_SHA256:artifact.manifestSHA256,SANDBOX_RUNTIME_MANIFEST_SHA256:artifact.runtimeManifestSHA256}
  const interrupt=()=>{interrupted=true;void Promise.all([...owned].map(stop)).finally(()=>{process.exitCode=130})}
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt)
  try{
    await runMatrix(config,{
      startPreview:()=>launch(process.execPath,['scripts/local-browser-sandbox-preview.mjs'],config.site,'preview',env),
      readyPreview:handle=>ready(handle,'http://127.0.0.1:4199/__sandbox/bridge.html'),
      startOwner:row=>launch('corepack',['pnpm@11.1.0','run','dev','--','--host','127.0.0.1','--strictPort'],config.site,row.id+'-owner',{...env,VITE_LOCAL_BROWSER_SANDBOX:'1',SANDBOX_LOCAL_SOURCE:join(config.sourceRepository,'examples/react',row.id),SANDBOX_LOCAL_FIXTURE:row.fixture,PORT:'4198'}),
      readyOwner:handle=>ready(handle,'http://127.0.0.1:4198/__sandbox-local/project.json',true),
      async runCell(row,browser){
        const output=join(config.output,row.id+'-'+browser+'.json')
        const handle=launch(process.execPath,[join(root,'scripts/run-tanstack-four-example.mjs'),'--runtime','sdk','--example',row.id,'--owner-url',`http://127.0.0.1:4198/${row.library}/latest/docs/framework/react/examples/${row.id}`,'--browser',browser,'--source-repository',config.sourceRepository,'--artifact-json',config.artifact,'--integration-json',config.integration,'--observed-commands-json',config.observedCommands,'--adaptations-json',row.adaptations,'--out',output],root,row.id+'-'+browser)
        const result=await handle.done;owned.delete(handle)
        if(result.code!==0)throw Error('Browser cell failed: '+row.id+' '+browser)
        const report=validateRunReport(json(output),loadContract())
        if(report.result!=='passed')throw Error('Browser behavior failed: '+row.id+' '+browser)
      },stop,
    })
  }finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);await Promise.all([...owned].map(stop))}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv[2]).catch(error=>{console.error(error);process.exitCode=1})
