import {test,expect} from '@playwright/test'
import {mkdtemp,mkdir,writeFile,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fork} from 'node:child_process'

test('native Vite browser cold and cached startup preserve HMR state',async({page},info)=>{
 test.setTimeout(45000)
 for(const key of ['NAPI_RS_ASYNC_WORK_POOL_SIZE','UV_THREADPOOL_SIZE'])if(process.env[key]!==undefined)throw Error('Unexpected pool override: '+key)
 const project=await mkdtemp(join(tmpdir(),'native-vite-browser-')),app=join(project,'app'),fixture=resolve('fixtures/vite-rolldown-wasm')
 await mkdir(app);await symlink(join(fixture,'node_modules'),join(project,'node_modules'),'dir')
 await writeFile(join(app,'index.html'),'<html><head><title>Agent Vite preview</title></head><body><button id="count"></button><p id="message"></p><script type="module" src="/main.ts"></script></body></html>')
 await writeFile(join(app,'message.ts'),'export const message: string = "first version";')
 await writeFile(join(app,'main.ts'),`import {message} from './message';let count: number=42;const button=document.querySelector('#count');button.textContent=String(count);button.onclick=()=>button.textContent=String(++count);document.querySelector('#message').textContent=message;if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);`)
 const evidence={project,scope:'Real native browser JS and WebSocket HMR, two fresh Node processes with installed WASM binding and shared cache. Direct HTTP transport, not URLPreview. Native memory is not sandbox budget parity.',rounds:[]}
 let failure
 try{for(const [round,initial,next]of [['cold','first version','second version'],['warm','second version','third version']]){
  const row={round,stdout:'',stderr:'',messages:[],cleanup:[]};evidence.rounds.push(row)
  const child=fork(resolve('scripts/native-vite-browser-server.mjs'),[app],{cwd:project,execArgv:[],env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:join(fixture,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'),DEBUG:'vite:deps'},stdio:['ignore','pipe','pipe','ipc']})
  let readyResolve,cacheResolve,resultResolve,exitResolve,abortReject
  const ready=new Promise(resolve=>readyResolve=resolve),cache=new Promise(resolve=>cacheResolve=resolve),result=new Promise(resolve=>resultResolve=resolve),exited=new Promise(resolve=>exitResolve=resolve)
  const aborted=new Promise((_,reject)=>abortReject=reject);aborted.catch(()=>{})
  const timer=setTimeout(()=>{row.deadline=true;abortReject(Error('15-second browser round deadline'));child.kill('SIGKILL')},15000)
  child.stdout.on('data',chunk=>row.stdout=(row.stdout+chunk).slice(-32768));child.stderr.on('data',chunk=>row.stderr=(row.stderr+chunk).slice(-32768))
  child.on('error',abortReject)
  child.on('exit',(code,signal)=>{row.exit={code,signal};exitResolve();if(!row.result)abortReject(Error('Native server exited before result'))})
  child.on('message',message=>{if(row.messages.length<16)row.messages.push(message.type);if(message.type==='ready')readyResolve(message.url);if(message.type==='cache-published')cacheResolve();if(message.type==='result'){row.result=message.result;resultResolve(message.result)}})
  const browserMessages=[];const onConsole=message=>{if(browserMessages.length<96)browserMessages.push(message.text().slice(0,500))};page.on('console',onConsole)
  try{
   const url=await Promise.race([ready,aborted]);row.url=url
   await page.goto(url)
   await expect(page.locator('#message')).toHaveText(initial,{timeout:5000})
   await expect(page.locator('#count')).toHaveText('42',{timeout:5000})
   await expect.poll(()=>browserMessages.some(text=>text.includes('[vite] connected.')),{timeout:5000}).toBe(true)
   await page.locator('#count').click();await expect(page.locator('#count')).toHaveText('43')
   const marker='native-'+round;await page.evaluate(value=>document.documentElement.dataset.resumeMarker=value,marker)
   await writeFile(join(app,'message.ts'),'export const message: string = '+JSON.stringify(next)+';')
   await expect(page.locator('#message')).toHaveText(next,{timeout:5000});await expect(page.locator('#count')).toHaveText('43')
   expect(await page.evaluate(()=>document.documentElement.dataset.resumeMarker)).toBe(marker)
   await Promise.race([cache,aborted]);child.send({type:'stop'})
   const completed=await Promise.race([result,aborted]);expect(completed.failure).toBeUndefined()
   await Promise.race([exited,aborted]);expect(row.exit.code).toBe(0)
   row.cacheAccepted=row.stderr.includes('Hash is consistent. Skipping.')
   expect(completed.afterCache.exists).toBe(true)
   expect(completed.beforeCache.exists).toBe(round==='warm')
   if(round==='warm')expect(row.cacheAccepted).toBe(true)
  }catch(error){row.failure=String(error.stack??error);throw error}
  finally{clearTimeout(timer);page.off('console',onConsole);row.browserMessages=browserMessages;if(child.exitCode===null&&child.signalCode===null){row.cleanup.push('Killed owned child after failed round');child.kill('SIGKILL');await exited}}
 }}catch(error){failure=error;evidence.failure=String(error.stack??error)}
 const path=info.outputPath('native-vite-resume.json');await writeFile(path,JSON.stringify(evidence,null,2));await info.attach('native-vite-resume.json',{path,contentType:'application/json'})
 if(failure)throw failure
})
