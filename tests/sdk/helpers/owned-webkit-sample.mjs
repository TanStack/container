import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {basename,resolve,sep} from 'node:path'

const execute=promisify(execFile)
export function parseProcesses(text){
  return text.split('\n').flatMap(line=>{
    const match=line.match(/^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/)
    return match?[{pid:Number(match[1]),ppid:Number(match[2]),started:match[3].replace(/\s+/g,' '),command:match[4]}]:[]
  })
}
export function sameProcess(a,b){return !!a&&!!b&&a.pid===b.pid&&a.started===b.started&&a.command===b.command}
export function ownedDescendants(rows,anchor){
  if(!sameProcess(rows.find(row=>row.pid===anchor?.pid),anchor))return []
  const byId=new Map(rows.map(row=>[row.pid,row]))
  return rows.filter(row=>{
    const seen=new Set([row.pid]);let parent=row.ppid
    while(parent&& !seen.has(parent)){
      if(parent===anchor.pid)return true
      seen.add(parent);parent=byId.get(parent)?.ppid
    }
    return false
  })
}
export async function processSnapshot(){
  const {stdout}=await execute('/bin/ps',['-axo','pid=,ppid=,lstart=,comm='],{encoding:'utf8',timeout:3000,maxBuffer:4*1024*1024,env:{...process.env,LC_ALL:'C'}})
  return parseProcesses(stdout)
}
export function ownerIsLive(rows,owner,currentPid=process.pid){
  const anchor=owner?.anchor
  if(!anchor||!sameProcess(rows.find(row=>row.pid===anchor.pid),anchor))return false
  if(owner.kind==='current-worker')return owner.pid===currentPid&&anchor.pid===currentPid
  if(owner.kind==='child')return owner.child?.pid===anchor.pid&&owner.child.exitCode===null&&owner.child.signalCode===null
  return false
}
export function ownedWebKitProcesses(rows,owner,bundleRoot,currentPid=process.pid){
  if(!ownerIsLive(rows,owner,currentPid))return []
  return ownedDescendants(rows,owner.anchor).filter(row=>row.command.startsWith(resolve(bundleRoot)+sep)&&/^com\.apple\.WebKit\.(WebContent|Networking|GPU)(\.[A-Za-z]+)*$/.test(basename(row.command)))
}
export async function currentWorkerOwner(){
  const pid=process.pid,anchor=(await processSnapshot()).find(row=>row.pid===pid)
  if(!anchor)throw Error('Current Playwright worker was absent from process snapshot')
  return {kind:'current-worker',pid,anchor}
}
export async function sampleOwnedWebKit(owner,bundleRoot){
  const anchor=owner?.anchor
  const evidence={anchor,owned:[],samples:[]}
  if(process.platform!=='darwin')return {...evidence,unavailable:'macOS sample is unavailable on this platform'}
  try{
    const initial=await processSnapshot()
    if(!ownerIsLive(initial,owner))return {...evidence,unavailable:'Owned process is not live or its identity changed'}
    evidence.owned=ownedWebKitProcesses(initial,owner,bundleRoot)
    const candidates=[...evidence.owned]
      .sort((a,b)=>Number(b.command.includes('WebContent'))-Number(a.command.includes('WebContent'))).slice(0,2)
    if(!candidates.length)return {...evidence,unavailable:'No verified owned WebKit descendants. Reparented XPC processes are not sampled.'}
    for(const candidate of candidates){
      // Recheck the live owner identity and the entire current parent chain.
      // A previous snapshot never authorizes sampling a reparented process.
      const current=ownedWebKitProcesses(await processSnapshot(),owner,bundleRoot)
      if(!current.some(row=>sameProcess(row,candidate))){evidence.samples.push({candidate,unavailable:'Ownership changed before sampling'});continue}
      try{
        const {stdout,stderr}=await execute('/usr/bin/sample',[String(candidate.pid),'2','10','-file','/dev/stdout'],{encoding:'utf8',timeout:5000,maxBuffer:2*1024*1024})
        evidence.samples.push({candidate,stdout,stderr})
      }catch(error){evidence.samples.push({candidate,unavailable:String(error),stdout:String(error.stdout??'').slice(0,2*1024*1024),stderr:String(error.stderr??'').slice(0,8192)})}
    }
    return evidence
  }catch(error){return {...evidence,unavailable:String(error)}}
}
