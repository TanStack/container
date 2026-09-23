import {webkit} from 'playwright'
import {execFileSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'

// macOS WebKit renderer RSS. This is a process-level regression measurement,
// not a portable JS heap API or a measurement of physical iPhone memory.
const [base='http://127.0.0.1:4184',mode='combined',label='current']=process.argv.slice(2)
const limitMiB=Number(process.env.MEMORY_LIMIT_MIB??2048)
if(!Number.isFinite(limitMiB)||limitMiB<0)throw new Error('Invalid MEMORY_LIMIT_MIB')
const idleMs=Number(process.env.MEMORY_IDLE_MS??20000)
if(!Number.isFinite(idleMs)||idleMs<0||idleMs>90000)throw new Error('Invalid MEMORY_IDLE_MS')
if(process.platform!=='darwin')throw new Error('This RSS probe currently requires macOS')
if(!/^[a-z0-9-]+$/.test(label))throw new Error('Invalid report label')
function renderers(){
  return execFileSync('ps',['-axo','pid=,rss=,comm='],{encoding:'utf8'}).trim().split('\n')
    .filter(x=>x.includes('ms-playwright/webkit')&&x.includes('WebContent'))
    .map(x=>{const m=x.trim().match(/^(\d+)\s+(\d+)/);return {pid:Number(m[1]),rssMiB:Number(m[2])/1024}})
}
const old=new Set(renderers().map(x=>x.pid))
const samples=[]
let phase='boot',peakMiB=0
function sample(){
  const rows=renderers().filter(x=>!old.has(x.pid))
  const rssMiB=rows.reduce((n,x)=>n+x.rssMiB,0)
  peakMiB=Math.max(peakMiB,rssMiB)
  samples.push({elapsedMs:Date.now()-started,phase,rssMiB,pids:rows.map(x=>x.pid)})
  return Math.round(rssMiB)
}
const started=Date.now(),browser=await webkit.launch()
let interval,error
const watchdog=setTimeout(()=>{error??='Memory probe exceeded 180 seconds';void browser.close()},180000)
try{
  const page=await browser.newPage()
  const profile=process.env.ENGINE_PROFILE
  if(profile){
    if(!['o1','o2','oz'].includes(profile))throw new Error('Invalid engine profile')
    await page.route('**/quickjs-als-asyncify/*',async route=>{
      const response=await route.fetch({url:route.request().url().replace('/quickjs-als-asyncify/','/quickjs-als-asyncify-'+profile+'/')})
      await route.fulfill({response})
    })
  }
  page.on('crash',()=>{error??='Page crashed'})
  page.on('pageerror',e=>{error??=String(e)})
  await page.exposeFunction('memoryPhase',value=>{
    phase=value;console.log(value+': '+sample()+' MiB')
  })
  await page.goto(base+'/sandbox.html')
  console.log('baseline: '+sample()+' MiB')
  interval=setInterval(()=>{
    const rss=sample()
    if(limitMiB&&rss>limitMiB&&!error){
      error=`Renderer RSS exceeded ${limitMiB} MiB (${rss} MiB observed)`
      void browser.close()
    }
  },1000)
  if(mode==='compile'){
    await page.evaluate(async()=>{
      const w=new window.sandboxLab.Workspace({files:{'/main.mjs':'console.log(42)'}})
      try{for(let i=1;i<=35;i++){await w.bundle('/main.mjs');if(i%5===0)await window.memoryPhase('compile '+i)}}finally{w.close()}
    })
  }else if(mode==='vm'||mode==='stress'){
    await page.evaluate(async stress=>{
      const script=document.querySelector('script[type="module"]').src
      const source=await (await fetch(script)).text()
      const path=source.match(/\/assets\/vm-combined\.worker-[\w-]+\.js/)?.[0]
      if(!path)throw new Error('Combined worker asset not found')
      for(let i=1;i<=(stress?3:35);i++){
        await new Promise((resolve,reject)=>{
          const worker=new Worker(path,{type:'module'})
          const timer=setTimeout(()=>{worker.terminate();reject(new Error('Worker timeout'))},15000)
          worker.onerror=e=>{clearTimeout(timer);worker.terminate();reject(new Error(e.message))}
          worker.onmessage=e=>{if(e.data.type==='done'||e.data.type==='error'){
            clearTimeout(timer);worker.terminate();e.data.type==='error'?reject(new Error(e.data.error)):resolve()
          }}
          const code=stress?`const ALS=__webContainerHost.AsyncLocalStorage;
            const s=new ALS();const values=await Promise.all(Array.from({length:500},(_,i)=>s.run(i,async()=>{
              for(let n=0;n<5;n++)await 0;return s.getStore()
            })));if(!values.every((v,i)=>v===i))throw Error('Context mismatch');console.log(true);`:'await 0; console.log(42)'
          worker.postMessage({type:'execute',code,env:{},argv:[],maxBytes:16*1024*1024,timeoutMs:5000})
        })
        if(stress||i%5===0)await window.memoryPhase('VM '+i)
      }
    },mode==='stress')
  }else if(mode==='als'){
    await page.evaluate(async()=>{
      let i=0;const report=await window.sandboxLab.runEngineALS(()=>{if(++i%5===0)window.memoryPhase('ALS '+i)},'quickjs-als-asyncify')
      if(report.results.some(x=>x.status!=='match'))throw new Error('ALS mismatch')
    })
  }else if(mode==='combined'){
    await page.evaluate(async()=>{
      const report=await window.sandboxLab.runEngineALS(undefined,'quickjs-als-asyncify')
      if(report.results.some(x=>x.status!=='match'))throw new Error('ALS mismatch')
      await window.memoryPhase('ALS complete')
      await window.sandboxLab.runCombinedIO();await window.memoryPhase('IO complete')
      await window.sandboxLab.runCombinedStart(message=>{if(!message.startsWith('Installing'))window.memoryPhase(message)})
      await window.memoryPhase('Start complete')
    })
  }else if(mode==='kernel'||mode==='kernel-repeat'){
    for(let i=1;i<=(mode==='kernel-repeat'?3:1);i++){
      await page.evaluate(()=>window.sandboxLab.runWorkerKernel(message=>{if(!message.startsWith('Installing'))window.memoryPhase(message)}))
      phase='kernel cycle '+i;console.log(phase+': '+sample()+' MiB')
    }
  }else if(mode==='start'){
    await page.evaluate(()=>window.sandboxLab.runCombinedStart(message=>{if(!message.startsWith('Installing'))window.memoryPhase(message)}))
  }else throw new Error('Unknown mode')
  phase='idle';console.log('completed: '+sample()+' MiB')
  if(process.env.CPU_SAMPLE==='1'){
    const targets=renderers().filter(x=>!old.has(x.pid))
    if(targets.length!==1)throw new Error('Expected one owned renderer')
    mkdirSync('reports',{recursive:true})
    execFileSync('sample',[String(targets[0].pid),'2','-file',`reports/memory-stacks-${label}.txt`],{timeout:15000})
  }
  if(process.env.MEMORY_MAP==='1'){
    const targets=renderers().filter(x=>!old.has(x.pid))
    if(targets.length!==1)throw new Error('Expected one owned renderer')
    const map=execFileSync('vmmap',['-summary',String(targets[0].pid)],{encoding:'utf8',timeout:15000})
    mkdirSync('reports',{recursive:true})
    writeFileSync(`reports/memory-map-${label}.txt`,map)
    console.log(map)
  }
  await page.waitForTimeout(idleMs)
  await page.evaluate(()=>document.body.dataset.responsive='yes')
  console.log('idle: '+sample()+' MiB')
  if(process.env.DIAGNOSTIC_GC==='1'){
    await page.requestGC()
    await page.waitForTimeout(3000)
    phase='diagnostic forced GC';console.log(phase+': '+sample()+' MiB')
  }
}catch(e){error??=String(e)}finally{
  clearTimeout(watchdog);clearInterval(interval);await browser.close()
  mkdirSync('reports',{recursive:true})
  writeFileSync(`reports/memory-${mode}-${label}.json`,JSON.stringify({generatedAt:new Date().toISOString(),
    platform:process.platform,base,mode,browser:'Playwright WebKit',browserVersion:browser.version(),
    profile:process.env.ENGINE_PROFILE||'default',limitMiB,idleMs,peakMiB,error:error??null,samples},null,2)+'\n')
}
if(error)throw new Error(error)
console.log('peak: '+Math.round(peakMiB)+' MiB')
