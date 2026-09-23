import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const report=JSON.parse(readFileSync('reports/compiler-scale-browser-results.json','utf8'))
const sources=report.config.metadata.sources
if(!sources||Object.keys(sources).length<10)throw Error('Missing compiler scale fingerprints')
for(const [path,hash] of Object.entries(sources))if(createHash('sha256').update(readFileSync(path)).digest('hex')!==hash)throw Error('Compiler scale evidence is stale: '+path)
const rows=[]
function walk(suite){
  for(const spec of suite.specs??[])for(const test of spec.tests??[]){
    const result=test.results.at(-1),attachment=result.attachments?.find(x=>x.name==='compiler-scale.json')
    if(!attachment)throw Error('Missing compiler scale result: '+test.projectName+' '+spec.title)
    const evidence=JSON.parse(Buffer.from(attachment.body,'base64').toString())
    const stages=evidence.result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(x=>x.progress).map(x=>x.progress)
    rows.push({browser:test.projectName,status:result.status,...evidence,stages})
  }
  for(const child of suite.suites??[])walk(child)
}
walk(report)
for(const browser of ['chromium','firefox','webkit'])for(const [profile,counts] of [['baseline',[100,1000,5000]],['desktop',[1000,5000]]])for(const count of counts)if(rows.filter(x=>x.browser===browser&&x.profile===profile&&x.count===count).length!==1)throw Error('Incomplete scale matrix')
const output={generatedAt:new Date().toISOString(),sources,stats:report.stats,rows}
writeFileSync('reports/compiler-scale-summary.json',JSON.stringify(output,null,2)+'\n')
console.log(JSON.stringify(rows.map(({browser,profile,count,status,result,ui,stages})=>({browser,profile,count,status,stages,ui,outerWasmHeapBytes:result.wasmHeapBytes,error:result.stderr.split('\n')[0]})),null,2))
if(report.stats.unexpected||report.stats.flaky||report.stats.skipped)process.exitCode=1
