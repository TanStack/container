import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {readFile,readdir} from 'node:fs/promises'
import {installNativeWorkerLifecycleObservation} from './native-worker-lifecycle-observation.mjs'

export function linuxProcessMemory(status){
  const name=status.match(/^Name:\s*(\S+)/m)?.[1]
  const fields={}
  for(const [key,unit]of [['VmRSS','kB'],['RssAnon','kB'],['RssFile','kB'],['VmSize','kB'],['Threads','']]){
    const match=status.match(new RegExp('^'+key+':\\s*(\\d+)'+(unit?'\\s+'+unit:'')+'\\s*$','m'))
    if(match)fields[key]=Number(match[1])*(unit?1024:1)
  }
  return {name,...fields}
}

export function linuxMemoryCounters(text){
  return Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line=>{
    const match=line.match(/^([a-z_]+) (\d+)$/)
    assert.ok(match,'Unexpected Linux memory counter')
    return [match[1],Number(match[2])]
  }))
}

export async function readLinuxOwnerMemory(){
  const processes=[]
  for(const pid of (await readdir('/proc')).filter(value=>/^\d+$/.test(value))){
    let status
    try{status=await readFile('/proc/'+pid+'/status','utf8')}
    catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error}
    const row=linuxProcessMemory(status)
    if(['WPEWebProcess','WPENetworkProcess','MiniBrowser','node'].includes(row.name))
      processes.push({pid:Number(pid),...row})
  }
  const [current,peak,events,stats]=await Promise.all(['memory.current','memory.peak','memory.events','memory.stat']
    .map(name=>readFile('/sys/fs/cgroup/'+name,'utf8')))
  assert.match(current.trim(),/^\d+$/)
  assert.match(peak.trim(),/^\d+$/)
  return {currentBytes:Number(current),peakBytes:Number(peak),events:linuxMemoryCounters(events),
    stats:linuxMemoryCounters(stats),processes:processes.sort((a,b)=>a.pid-b.pid)}
}

// Opt-in preload, not an SDK/runtime hook. The original driver still owns all
// behavior, cleanup, assertions and deadlines. Sampling never forces GC.
if(process.env.NATIVE_LINUX_MEMORY_OBSERVE==='1'){
  assert.equal(process.platform,'linux')
  const require=createRequire('/work/web-container-source/package.json')
  const lock=JSON.parse(await readFile('/work/web-container-source/package-lock.json','utf8'))
  assert.equal(require('@playwright/test/package.json').version,lock.packages['node_modules/@playwright/test'].version)
  const {webkit}=require('@playwright/test')
  const instrumentation=Object.fromEntries(await Promise.all([
    ['preload',new URL(import.meta.url)],['lifecycle',new URL('./native-worker-lifecycle-observation.mjs',import.meta.url)],
  ].map(async([name,url])=>[name,createHash('sha256').update(await readFile(url)).digest('hex')])))
  const launch=webkit.launch
  webkit.launch=async function(){
    const browser=await Reflect.apply(launch,this,arguments)
    let pageId=0,nextSample=0,sampling=false,closed=false
    const started=performance.now()
    const sample=async(scope)=>{
      if(sampling||closed)return
      sampling=true
      try{
        const memory=await readLinuxOwnerMemory()
        console.log('NATIVE_LINUX_MEMORY '+JSON.stringify({scope,sequence:++nextSample,
          elapsedMs:Math.round(performance.now()-started),instrumentation,...memory}))
      }catch(error){console.error('NATIVE_LINUX_MEMORY_ERROR '+String(error))}
      finally{sampling=false}
    }
    await sample('browser launched')
    const timer=setInterval(()=>void sample('periodic'),1000)
    timer.unref()
    const newPage=browser.newPage
    browser.newPage=async function(){
      const page=await Reflect.apply(newPage,this,arguments),id=++pageId
      await page.addInitScript(installNativeWorkerLifecycleObservation)
      page.on('console',message=>{
        if(message.text().startsWith('NATIVE_WORKER_LIFECYCLE '))
          console.log('NATIVE_LINUX_WORKER '+JSON.stringify({page:id,...JSON.parse(message.text().slice('NATIVE_WORKER_LIFECYCLE '.length))}))
      })
      page.on('close',()=>void sample('page '+id+' closed'))
      await sample('page '+id+' created')
      return page
    }
    browser.on('disconnected',()=>{clearInterval(timer);closed=true})
    return browser
  }
}
