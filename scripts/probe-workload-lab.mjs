import {chromium} from '@playwright/test'
import {readFile} from 'node:fs/promises'
const browser=await chromium.launch()
try{
  const page=await browser.newPage()
  const errors=[]
  page.on('pageerror',error=>errors.push(String(error)))
  page.on('crash',()=>errors.push('Page crashed'))
  await page.goto('http://127.0.0.1:4187/sandbox.html')
  await page.getByRole('button',{name:'Test package workloads',exact:true}).click()
  const download=page.waitForEvent('download',{timeout:180000})
  await page.getByRole('link',{name:'Download workload report',exact:true}).click({timeout:180000})
  await (await download).saveAs('reports/workload-lab-chromium.json')
  const report=JSON.parse(await readFile('reports/workload-lab-chromium.json','utf8'))
  if(report.results.length!==report.manifest.cases.length||report.results.some(row=>row.status==='fixture-error'))throw Error('Incomplete lab report')
  if(errors.length)throw Error(errors.join('\n'))
  await page.screenshot({path:'reports/workload-lab-chromium.png',fullPage:true})
  console.log('Lab action completed and downloaded',report.results.length,'workload results')
}finally{await browser.close()}
