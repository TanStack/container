import {test,expect} from '@playwright/test'
import {readFileSync,existsSync} from 'node:fs'
import type {WorkloadManifest} from '../../src/feasibility/workloads'
const manifest=JSON.parse(readFileSync('public/workloads/manifest.json','utf8')) as WorkloadManifest
const baselinePath='compat/workload-baseline.json'
const baseline:Record<string,string[]>=existsSync(baselinePath)?JSON.parse(readFileSync(baselinePath,'utf8')):{}
for(const fixture of manifest.cases){
  test(fixture.id+' | '+fixture.scope,async({page},info)=>{
    const errors:string[]=[]
    page.on('pageerror',error=>errors.push(String(error)))
    page.on('crash',()=>errors.push('Page crashed'))
    await page.goto('/sandbox.html')
    const report=await page.evaluate(id=>window.sandboxLab.runWorkload(id),fixture.id)
    await info.attach('workload.json',{body:JSON.stringify(report),contentType:'application/json'})
    console.log(info.project.name,report.id,report.status,report.error?.slice(0,240)??'')
    expect(errors).toEqual([])
    expect(report.status).not.toBe('fixture-error')
    if(baseline[info.project.name]?.includes(fixture.id)){
      expect(['pass','adapted-pass'],report.error).toContain(report.status)
    }
    if(report.status==='pass'||report.status==='adapted-pass')expect(report.iterations).toHaveLength(4)
    // A gap is recorded, not a compatibility pass. Test success means the
    // experiment completed and the browser stayed usable.
    await expect(page.locator('h1')).toHaveText('Sandbox feasibility lab')
  })
}
