import {AgentSession,WorkerHTTP,URLPreview} from '@tanstack/browser-sandbox-experimental'

const source=document.querySelector('#source'),output=document.querySelector('#output')
const buttons=['run','save','resume'].map(id=>document.getElementById(id))
const storageKey='sdk-basic-workspace-v1'
const files={
  '/message.txt':source.value,
  '/check.cjs':`const assert=require('node:assert/strict');const text=require('node:fs').readFileSync('/message.txt','utf8');assert.ok(text.trim(),'Enter a message');console.log(text)`,
  '/server.cjs':`const http=require('node:http'),fs=require('node:fs');http.createServer((req,res)=>{const text=fs.readFileSync('/message.txt','utf8').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><title>Workspace preview</title></head><body><p id="message">'+text+'</p></body></html>')}).listen(8527,()=>console.log('READY'))`,
}
const options={assetBaseURL:new URL('/runtime/',location.href).href,timeoutMs:15000}
let session=new AgentSession(files,options),child,preview
const {previewOrigin}=await(await fetch('/config.json')).json()
async function stop(){preview?.close();preview=undefined;if(child){const current=child;child=undefined;await current.dispose()}}
async function action(work){
  buttons.forEach(button=>button.disabled=true)
  try{await work()}catch(error){output.textContent=String(error);await stop().catch(()=>{})}
  finally{buttons.forEach(button=>button.disabled=false)}
}
document.querySelector('#run').onclick=()=>action(async()=>{
  await stop()
  await session.write({path:'/message.txt',text:source.value})
  const result=await session.run({command:'node',args:['/check.cjs']})
  output.textContent=`Exit ${result.status}\n${result.stdout}${result.stderr}`
  if(result.status!==0)return
  child=await session.kernel.spawn('node',['/server.cjs'],{lifetime:'session',timeoutMs:15000})
  let startup=''
  for(;;){
    const event=await child.next()
    if(event?.type==='stdout'||event?.type==='stderr')startup+=new TextDecoder().decode(event.bytes)
    if(startup.includes('READY'))break
    if(!event||event.type==='exit')throw Error('Server did not start: '+startup)
  }
  preview=await URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server:new WorkerHTTP(session.kernel,8527)})
})
document.querySelector('#save').onclick=()=>action(async()=>{
  await stop();await session.write({path:'/message.txt',text:source.value})
  localStorage.setItem(storageKey,JSON.stringify(await session.snapshot()))
  output.textContent='Files saved. Reload the host page, then resume.'
})
document.querySelector('#resume').onclick=()=>action(async()=>{
  const saved=localStorage.getItem(storageKey)
  if(!saved)throw Error('No saved workspace on this origin')
  await stop();await session.close();session=new AgentSession({},options)
  await session.restore({snapshot:JSON.parse(saved)})
  source.value=(await session.read({path:'/message.txt'})).text
  output.textContent='Files restored in a fresh runtime. Run to restart the app.'
})
document.querySelector('#reload').onclick=()=>location.reload()
addEventListener('pagehide',()=>{preview?.close();void session.close()})
buttons.forEach(button=>button.disabled=false)
output.textContent='Ready'
