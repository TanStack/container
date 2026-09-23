import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const report=JSON.parse(readFileSync('reports/workspace-assets-browser-results.json','utf8'))
const sources=report.config.metadata.sources
if(!sources||Object.keys(sources).length<10)throw Error('Missing workspace asset source fingerprints')
for(const [path,hash] of Object.entries(sources))if(createHash('sha256').update(readFileSync(path)).digest('hex')!==hash)throw Error('Workspace asset evidence is stale: '+path)
const rows=[]
function walk(suite){
  for(const spec of suite.specs??[])for(const test of spec.tests??[])for(const result of test.results??[]){
    const attachment=result.attachments?.find(item=>item.name==='package-asset-probe.json'||item.name==='cleanup-control.json')
    rows.push({browser:test.projectName,name:spec.title,status:result.status,
      kind:spec.title.includes('real package asset')?'package':spec.title.includes('cleanup control')?'control':'asset',
      evidence:attachment?JSON.parse(Buffer.from(attachment.body,'base64').toString()):undefined,
      errors:result.errors?.map(error=>error.message)})
  }
  for(const child of suite.suites??[])walk(child)
}
walk(report)
const output={generatedAt:new Date().toISOString(),sources,stats:report.stats,
  assetChecks:rows.filter(row=>row.kind==='asset'&&row.status==='passed').length,
  packagePasses:rows.filter(row=>row.kind==='package'&&row.status==='passed'&&row.evidence?.status==='pass').length,
  packageGaps:rows.filter(row=>row.kind==='package'&&row.status==='passed'&&row.evidence?.status==='gap').length,
  failures:rows.filter(row=>row.status!=='passed').map(({browser,name,errors})=>({browser,name,errors})),rows}
writeFileSync('reports/workspace-assets-summary.json',JSON.stringify(output,null,2)+'\n')
console.log(JSON.stringify({...output,sources:undefined,rows:undefined,failures:output.failures.map(row=>({...row,errors:row.errors.map(error=>error.slice(0,200))}))},null,2))
if(report.stats.unexpected||report.stats.flaky||report.stats.skipped)process.exitCode=1
