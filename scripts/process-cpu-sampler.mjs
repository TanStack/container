import {execFileSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {basename} from 'node:path'

const output=resolve(process.env.PROCESS_CPU_REPORT??'reports/process-cpu-samples.json')
const durationMs=Number(process.env.PROCESS_CPU_DURATION_MS??150000)
const intervalMs=Number(process.env.PROCESS_CPU_INTERVAL_MS??2000)
if(!Number.isInteger(durationMs)||durationMs<1000||durationMs>180000)throw Error('PROCESS_CPU_DURATION_MS must be from 1000 through 180000')
if(!Number.isInteger(intervalMs)||intervalMs<500||intervalMs>10000)throw Error('PROCESS_CPU_INTERVAL_MS must be from 500 through 10000')

const startedAt=new Date().toISOString(),samples=[]
const relevant=executable=>/safaridriver|Safari|WebKit\.WebContent|wasm-opt|emcc|clang/.test(executable)
const category=executable=>executable.includes('WebKit.WebContent')?'WebContent'
  :executable==='safaridriver'?'safaridriver'
    :executable.includes('Safari')?'Safari'
      :executable==='wasm-opt'?'wasm-opt'
        :/emcc|clang/.test(executable)?'compiler':'other'
function sample(){
  const text=execFileSync('/bin/ps',['axww','-o','pid=,etime=,rss=,%cpu=,comm='],{encoding:'utf8'})
  const processes=text.split('\n').flatMap(line=>{
    const match=line.trim().match(/^(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(.+)$/)
    if(!match)return []
    const cpuPercent=Number(match[4]),executable=basename(match[5])
    if(cpuPercent<5&&!relevant(executable))return []
    return [{pid:Number(match[1]),elapsed:match[2],residentKiB:Number(match[3]),cpuPercent,category:category(executable),executable}]
  })
  samples.push({at:new Date().toISOString(),processes})
}

const deadline=Date.now()+durationMs
do{
  sample()
  if(Date.now()>=deadline)break
  await new Promise(resolveWait=>setTimeout(resolveWait,Math.min(intervalMs,deadline-Date.now())))
}while(Date.now()<=deadline)

const report={format:1,startedAt,finishedAt:new Date().toISOString(),durationMs,intervalMs,samples}
writeFileSync(output,JSON.stringify(report,null,2)+'\n')
console.log(output)
