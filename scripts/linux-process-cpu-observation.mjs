import assert from 'node:assert/strict'
import {readFile,readdir,readlink} from 'node:fs/promises'
import {basename} from 'node:path'
import {linuxMemoryCounters} from './linux-owner-memory-observation.mjs'

// Read-only metadata for an isolated test container. Never inspect arguments,
// environments, browser payloads or files from the project being exercised.
export function linuxProcessCPU(stat){
  const match=stat.trim().match(/^(\d+) \((.*)\) (\S) (.*)$/s)
  assert.ok(match,'Invalid Linux process stat')
  const fields=match[4].trim().split(/\s+/)
  const value=index=>{
    assert.match(fields[index]??'',/^\d+$/,'Missing Linux process counter')
    const number=Number(fields[index])
    assert.ok(Number.isSafeInteger(number),'Invalid Linux process counter')
    return number
  }
  const pid=Number(match[1])
  assert.ok(Number.isSafeInteger(pid)&&pid>0)
  return {pid,name:match[2].slice(0,128),state:match[3],parentPID:value(0),
    userTicks:value(10),systemTicks:value(11),startTicks:value(18),threads:value(16)}
}

export function linuxProcessCPUDelta(previous,current,{ticksPerSecond,elapsedMs}){
  assert.ok(Number.isSafeInteger(ticksPerSecond)&&ticksPerSecond>0)
  assert.ok(Number.isFinite(elapsedMs)&&elapsedMs>0)
  if(previous.pid!==current.pid||previous.startTicks!==current.startTicks)return undefined
  const userTicks=current.userTicks-previous.userTicks,systemTicks=current.systemTicks-previous.systemTicks
  if(userTicks<0||systemTicks<0)return undefined
  const cpuMs=(userTicks+systemTicks)*1000/ticksPerSecond
  return {pid:current.pid,cpuMs,cores:cpuMs/elapsedMs,userTicks,systemTicks}
}

export async function readLinuxProcessCPU({read=readFile,list=readdir,link=readlink,maxProcesses=128}={}){
  assert.ok(Number.isSafeInteger(maxProcesses)&&maxProcesses>0&&maxProcesses<=256)
  const selected=new Set(['node','chrome','chrome-headless-shell','headless_shell','firefox','firefox-bin',
    'WebKitWebProcess','WPEWebProcess','WPENetworkProcess','MiniBrowser'])
  const processes=[]
  let dropped=0
  for(const pid of (await list('/proc')).filter(value=>/^\d+$/.test(value))){
    let executable,stat
    try{
      executable=basename(await link('/proc/'+pid+'/exe'))
      if(!selected.has(executable))continue
      stat=await read('/proc/'+pid+'/stat','utf8')
    }catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error}
    const row=linuxProcessCPU(stat)
    assert.equal(row.pid,Number(pid),'Linux process identity changed')
    if(processes.length<maxProcesses)processes.push({...row,executable})
    else dropped++
  }
  const [cpu,memory,events]=await Promise.all(['cpu.stat','memory.current','memory.events']
    .map(name=>read('/sys/fs/cgroup/'+name,'utf8')))
  assert.match(memory.trim(),/^\d+$/)
  return {cpu:linuxMemoryCounters(cpu),memoryBytes:Number(memory),memoryEvents:linuxMemoryCounters(events),
    dropped,processes:processes.sort((a,b)=>a.pid-b.pid)}
}
