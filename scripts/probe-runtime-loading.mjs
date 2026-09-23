import {chromium} from '@playwright/test'
import {readFile,writeFile} from 'node:fs/promises'

// Read-only requests to an already running lab server. Each guest gets its own
// disposable kernel. This diagnostic does not change the compatibility baseline.
const base=new URL(process.argv[2]??'http://127.0.0.1:4199')
if(!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw Error('Use a local lab server')
const prior=JSON.parse(await readFile('reports/workload-matrix.json','utf8'))
const engine=await (await fetch(new URL('/quickjs-als/build.json',base))).json()
const ids=[...new Set(prior.kernel.filter(row=>row.browser==='chromium'&&row.status==='gap').map(row=>row.id))]
const browser=await chromium.launch(),results=[]
try{
  const page=await browser.newPage()
  await page.goto(new URL('/sandbox.html',base).href)
  for(const id of ids){
    const report=await page.evaluate(async id=>{
      const manifest=await (await fetch('/workloads/manifest.json')).json()
      manifest.cases=manifest.cases.map(row=>({...row,execution:'modules'}))
      return window.sandboxLab.runWorkload(id,manifest)
    },id)
    results.push(report)
    console.log(id,report.status,report.error?.slice(0,250)??'')
  }
}finally{await browser.close()}
await writeFile('reports/runtime-loading-discovery.json',JSON.stringify({generatedAt:new Date().toISOString(),browser:'chromium',engine,
  scope:'Existing prepared source graphs through the Node-shaped runtime loader. Graphs were mostly captured for browser bundling and may omit Node entrypoints or runtime assets. This is blocker discovery, not full package support.',results},null,2)+'\n')
