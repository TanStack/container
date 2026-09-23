import {spawn,spawnSync} from 'node:child_process'
import {createServer} from 'node:net'

const elementKey='element-6066-11e4-a52e-4f735466cecf'
const safariAutomationExecutable='/Safari.app/Contents/MacOS/Safari'

export function parseSafariAutomationProcesses(output){
  return String(output).split('\n').map(line=>line.trim()).filter(Boolean).flatMap(line=>{
    const match=line.match(/^(\d+)\s+(.+)$/)
    if(!match||!match[2].split(/\s+/,1)[0].endsWith(safariAutomationExecutable)||!/(?:^|\s)--automation(?:\s|$)/.test(match[2]))return []
    return [{pid:Number(match[1]),command:match[2]}]
  })
}

const processExists=pid=>{try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}}

export function listSafariAutomationProcesses(){
  const listed=spawnSync('/bin/ps',['axww','-o','pid=,command='],{encoding:'utf8'})
  if(listed.status!==0)throw Error(`Could not inspect Safari automation processes: ${listed.stderr}`)
  return parseSafariAutomationProcesses(listed.stdout)
}

export function inspectSafariAutomationProcess(pid){
  if(!Number.isInteger(pid)||pid<=0)throw Error('Expected a positive Safari automation process id')
  const process=listSafariAutomationProcesses().find(entry=>entry.pid===pid)
  return {pid,running:Boolean(process),automation:Boolean(process)}
}

export function assertSafariAutomationAvailable(){
  const processes=listSafariAutomationProcesses()
  if(processes.length){
    throw Object.assign(Error(`Safari automation is already in use by ${processes.length} process${processes.length===1?'':'es'}`),{
      code:'ERR_SAFARI_AUTOMATION_OCCUPIED',
      processCount:processes.length,
    })
  }
}

export async function stopSafariAutomationProcess(pid,{timeoutMs=10_000}={}){
  const inspected=inspectSafariAutomationProcess(pid)
  if(!inspected.running)return inspected
  process.kill(pid,'SIGTERM')
  const deadline=Date.now()+timeoutMs
  while(processExists(pid)){
    if(Date.now()>=deadline)throw Error(`Safari automation process ${pid} did not stop after ${timeoutMs}ms`)
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  return {...inspected,stopped:true}
}

export async function activateSafariAutomation({timeoutMs=10_000}={}){
  const deadline=Date.now()+timeoutMs
  let processes=[]
  while(Date.now()<deadline){
    const listed=spawnSync('/bin/ps',['axww','-o','pid=,command='],{encoding:'utf8'})
    if(listed.status!==0)throw Error(`Could not inspect Safari automation processes: ${listed.stderr}`)
    processes=parseSafariAutomationProcesses(listed.stdout)
    if(processes.length)break
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  if(processes.length!==1)throw Error(`Expected one Safari automation process, received ${processes.length}`)
  const activated=spawnSync('/usr/bin/osascript',['-e',`tell application "System Events" to set frontmost of first process whose unix id is ${processes[0].pid} to true`],{encoding:'utf8'})
  if(activated.status!==0)throw Error(`Could not activate Safari automation: ${activated.stderr}`)
  return processes[0]
}

export function classifySafariDriverFailure(value){
  const text=String(value?.message??value??'')
  if(/allow remote automation|remote automation.*(?:disabled|enable|not enabled)/i.test(text)){
    return Object.assign(Error('Safari remote automation is disabled. Enable Develop > Allow Remote Automation in Safari, then run this command again.'),{code:'ERR_SAFARI_REMOTE_AUTOMATION_DISABLED',cause:value})
  }
  return value instanceof Error?value:Error(text)
}

export function verifySafariFiberResult(result,expectedCycles){
  if(!Number.isInteger(expectedCycles)||expectedCycles<1)throw Error('Invalid expected fiber cycle count')
  if(result?.status!=='passed'||result.completed!==expectedCycles||result.last?.value!==239998879){
    throw Error(`Safari fiber workload did not complete correctly: ${JSON.stringify(result)}`)
  }
}

export function parseWebDriverResponse(status,body,operation){
  let payload
  try{payload=body?JSON.parse(body):{value:null}}catch{throw Error(`Safari WebDriver returned invalid JSON for ${operation}: HTTP ${status}`)}
  const value=payload?.value
  if(status<200||status>=300||value?.error){
    const error=classifySafariDriverFailure(value?.message??`${operation} failed with HTTP ${status}`)
    if(value?.error&&!error.code)Object.assign(error,{code:value.error})
    throw error
  }
  return value
}

export function createSafariEvidence({identity,capabilities,startedAt,finishedAt,results,rounds=[],requiredRepetitions=3,failure}){
  const browserName=String(capabilities?.browserName??capabilities?.browser??'Safari')
  if(capabilities&&browserName.toLowerCase()!=='safari')throw Error(`Expected Safari WebDriver, received ${browserName}`)
  const browserVersion=capabilities?.browserVersion??capabilities?.version??null
  const workflowsPassed=['vite','start'].every(name=>['cold','resume'].every(phase=>results[name][phase].status==='passed'))
  const repeated=rounds.length>=requiredRepetitions&&rounds.every(round=>['vite','start'].every(name=>['cold','resume'].every(phase=>round.results[name][phase].status==='passed')))
  const passed=workflowsPassed&&repeated
  if(passed&&!browserVersion)throw Error('Passing Safari evidence requires the browser version reported by WebDriver')
  return {
    format:1,actualSafari:Boolean(capabilities&&browserName.toLowerCase()==='safari'),
    method:'W3C WebDriver through /usr/bin/safaridriver with verified owner controls and trusted pointer input inside previews',
    browser:{name:'Safari',version:browserVersion},artifact:identity,
    startedAt,finishedAt,requiredRepetitions,rounds,results,
    passed,
    ...(failure?{failure}:{})
  }
}

async function unusedPort(){
  const server=createServer()
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const port=server.address().port
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
  return port
}

export class SafariWebDriver {
  constructor(origin,{requestTimeoutMs=30_000}={}){this.origin=origin;this.requestTimeoutMs=requestTimeoutMs;this.sessionId=undefined;this.capabilities=undefined}
  async request(method,path,body,timeoutMs=this.requestTimeoutMs){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs)
    try{
      const response=await fetch(this.origin+path,{method,headers:body===undefined?undefined:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal})
      return parseWebDriverResponse(response.status,await response.text(),method+' '+path)
    }catch(error){if(controller.signal.aborted)throw Object.assign(Error(`Safari WebDriver request timed out after ${timeoutMs}ms: ${method} ${path}`),{code:'ERR_SAFARI_WEBDRIVER_TIMEOUT'});throw classifySafariDriverFailure(error)}finally{clearTimeout(timer)}
  }
  async createSession(){
    const value=await this.request('POST','/session',{capabilities:{alwaysMatch:{browserName:'safari'}}},60_000)
    this.sessionId=value?.sessionId
    this.capabilities=value?.capabilities??value
    if(!this.sessionId)throw Error('Safari WebDriver did not return a session id')
    // Let Safari return its navigation error before the 60s HTTP deadline.
    // Aborting the client request alone does not cancel browser navigation.
    await this.command('POST','/timeouts',{pageLoad:55_000})
    return this.capabilities
  }
  path(path){if(!this.sessionId)throw Error('Safari WebDriver session is not open');return `/session/${encodeURIComponent(this.sessionId)}${path}`}
  command(method,path,body,timeout){return this.request(method,this.path(path),body,timeout)}
  navigate(url){return this.command('POST','/url',{url},60_000)}
  url(){return this.command('GET','/url')}
  execute(script,args=[]){return this.command('POST','/execute/sync',{script,args})}
  executeAsync(script,args=[],timeoutMs=60_000){return this.command('POST','/execute/async',{script,args},timeoutMs)}
  refresh(){return this.command('POST','/refresh',{},60_000)}
  maximizeWindow(){return this.command('POST','/window/maximize',{},60_000)}
  windowHandle(){return this.command('GET','/window')}
  windowHandles(){return this.command('GET','/window/handles')}
  async find(selector){const value=await this.command('POST','/element',{using:'css selector',value:selector});if(!value?.[elementKey])throw Error(`Safari did not return an element for ${selector}`);return value}
  click(element){return this.command('POST',`/element/${encodeURIComponent(element[elementKey])}/click`,{})}
  // SafariDriver interprets W3C action viewport coordinates against the top
  // browsing context even while an iframe is selected. Element Click performs
  // the spec-defined scroll and emits trusted pointer, mouse and click events
  // against the selected frame's element.
  pointerClick(element){return this.click(element)}
  clear(element){return this.command('POST',`/element/${encodeURIComponent(element[elementKey])}/clear`,{})}
  value(element,text){return this.command('POST',`/element/${encodeURIComponent(element[elementKey])}/value`,{text,value:[...text]})}
  text(element){return this.command('GET',`/element/${encodeURIComponent(element[elementKey])}/text`)}
  attribute(element,name){return this.command('GET',`/element/${encodeURIComponent(element[elementKey])}/attribute/${encodeURIComponent(name)}`)}
  property(element,name){return this.command('GET',`/element/${encodeURIComponent(element[elementKey])}/property/${encodeURIComponent(name)}`)}
  frame(element){return this.command('POST','/frame',{id:element})}
  parentFrame(){return this.command('POST','/frame/parent',{})}
  async close(){if(!this.sessionId)return;const id=this.sessionId;this.sessionId=undefined;try{await this.request('DELETE',`/session/${encodeURIComponent(id)}`)}catch{}}
}

export async function startSafariDriver({binary='/usr/bin/safaridriver',startupTimeoutMs=15_000}={}){
  const port=await unusedPort(),child=spawn(binary,['-p',String(port)],{stdio:['ignore','ignore','pipe']})
  let stderr='';child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-16_384)})
  const origin=`http://127.0.0.1:${port}`,deadline=Date.now()+startupTimeoutMs
  try{
    while(Date.now()<deadline){
      if(child.exitCode!==null)throw classifySafariDriverFailure(stderr||`safaridriver exited with code ${child.exitCode}`)
      try{const response=await fetch(origin+'/status');if(response.ok)return {driver:new SafariWebDriver(origin),child,stderr:()=>stderr}}catch{}
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    throw Object.assign(Error(`safaridriver did not become ready within ${startupTimeoutMs}ms: ${stderr}`),{code:'ERR_SAFARI_WEBDRIVER_STARTUP'})
  }catch(error){child.kill('SIGTERM');throw classifySafariDriverFailure(error)}
}

export async function stopSafariDriver(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return
  child.kill('SIGTERM')
  await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve()},5_000);child.once('exit',()=>{clearTimeout(timer);resolve()})})
}
