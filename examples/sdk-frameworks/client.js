import {AgentSession,WorkerHTTP,WorkerWebSocket,URLPreview,runShell,assertSDKRuntimeEnvironment} from '@tanstack/browser-sandbox-experimental'
import {withExampleTests,readScripts,runProjectScript,writeChangedSource,saveProject} from './scripts.mjs'
import {watchAppPort} from './ports.mjs'

const project=document.querySelector('#project'),source=document.querySelector('#source'),output=document.querySelector('#output')
const buttons=[...document.querySelectorAll('button')]
const scriptSelect=document.querySelector('#script')
const projects=await(await fetch('/projects.json')).json()
const {previewOrigin,runtimes}=await(await fetch('/config.json')).json()
let session,child,preview,drain,activeProject
const sourcePath=kind=>kind==='start'?'/project/src/routes/index.tsx':'/project/message.js'
const log=text=>{output.textContent=(output.textContent+text).slice(-32000)}
async function store(key,value){
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('sdk-frameworks-example',1);request.onupgradeneeded=()=>request.result.createObjectStore('projects');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction('projects',value===undefined?'readonly':'readwrite'),table=tx.objectStore('projects'),request=value===undefined?table.get(key):table.put(value,key);tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error)})}finally{db.close()}
}
async function stop(){preview?.close();preview=undefined;if(child){const current=child;child=undefined;await current.dispose()}await drain;drain=undefined}
function controls(busy=false){buttons.forEach(button=>button.disabled=busy);project.disabled=busy;source.disabled=busy||!session;scriptSelect.disabled=busy||!session;for(const id of ['save','apply','stop','refresh-scripts','run-script'])document.getElementById(id).disabled=busy||!session;document.querySelector('#run-script').disabled=busy||!session||!scriptSelect.value}
async function refreshScripts(){const selected=scriptSelect.value;scriptSelect.replaceChildren();for(const name of Object.keys(await readScripts(session))){const option=document.createElement('option');option.value=name;option.textContent=name;scriptSelect.append(option)}if([...scriptSelect.options].some(option=>option.value===selected))scriptSelect.value=selected;else if([...scriptSelect.options].some(option=>option.value==='test'))scriptSelect.value='test'}
async function action(work){controls(true);try{await work()}catch(error){log('\n'+String(error)+'\n');await stop().catch(()=>{});await closeSession().catch(()=>{})}finally{controls()}}
async function closeSession(){
  const current=session;session=undefined
  if(current)await current.close()
}
async function open(resume){
  await stop();await closeSession();activeProject=project.value
  const runtime=runtimes[activeProject]
  if(runtime.error)throw Error(runtime.error)
  const saved=resume?await store(activeProject):undefined
  if(resume&&!saved)throw Error('No saved '+activeProject+' project on this origin')
  output.textContent=resume?'Restoring files\n':'Installing dependencies\n'
  log('SDK profile: '+runtime.buildProfile+'\n')
  assertSDKRuntimeEnvironment(runtime)
  const maxBytes=(activeProject==='start'?256:128)*1024*1024
  session=new AgentSession(resume?{}:withExampleTests(projects[activeProject],activeProject),{assetBaseURL:new URL('/runtime/',location.href).href,...runtime.kernelOptions,maxBytes,workerMaxBytes:64*1024*1024,workspace:{maxBytes:128*1024*1024}})
  if(resume)await session.restore({snapshot:saved})
  else{const result=await session.install({options:{cwd:'/project',ignoreScripts:true}});log('Installed '+result.installed+' packages. Lifecycle scripts are disabled.\n')}
  const path=sourcePath(activeProject);document.querySelector('#path').textContent=path;source.value=(await session.read({path})).text
  await refreshScripts()
  const watching=watchAppPort(session.kernel)
  let port
  try{
    child=await session.kernel.spawn('node',['server.mjs'],{cwd:'/project',guestWasm:true,webAPIs:true,lifetime:'session',maxBytes:128*1024*1024,timeoutMs:30000})
    const running=child
    drain=(async()=>{try{for(;;){const event=await running.next();if(event?.type==='stdout'||event?.type==='stderr')log(new TextDecoder().decode(event.bytes));else break}}catch(error){log(String(error))}})()
    port=await Promise.race([watching.promise,drain.then(()=>{throw Error('App exited before opening a port')})])
  }finally{watching.cancel()}
  preview=await URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server:new WorkerHTTP(session.kernel,port),connectWebSocket:(url,protocols)=>WorkerWebSocket.connect(session.kernel,port,previewOrigin,url,protocols)})
  log('Preview attached\n')
}
document.querySelector('#open').onclick=()=>action(()=>open(false))
document.querySelector('#resume').onclick=()=>action(()=>open(true))
document.querySelector('#apply').onclick=()=>action(async()=>{await session.write({path:sourcePath(activeProject),text:source.value});log('Source written\n')})
document.querySelector('#save').onclick=()=>action(async()=>{await saveProject({session,path:sourcePath(activeProject),text:source.value,key:activeProject,stop,store,close:closeSession});log('Saved. Reload this page, then resume the same project.\n')})
document.querySelector('#stop').onclick=()=>action(async()=>{await stop();await closeSession();log('App stopped\n')})
scriptSelect.onchange=()=>controls()
document.querySelector('#refresh-scripts').onclick=()=>action(refreshScripts)
document.querySelector('#run-script').onclick=()=>action(async()=>{await writeChangedSource(session,sourcePath(activeProject),source.value);const name=scriptSelect.value;log('\nRunning '+name+'\n');const result=await runProjectScript(session,name,runShell);log(new TextDecoder().decode(result.stdout));log(new TextDecoder().decode(result.stderr));log('\n'+name+' exited with status '+result.exitCode+'\n')})
addEventListener('pagehide',()=>{preview?.close();void session?.close()})
output.textContent='Choose a project to install or resume.';controls()
