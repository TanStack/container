import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

const path=resolve(process.argv[2]??'')
if(!process.argv[2]||!path.includes('/reports/safari-fiber-interpreter-machine-cpu-'))throw Error('Expected an interpreter-machine CPU report path')
const report=JSON.parse(readFileSync(path,'utf8'))
const category=command=>command.includes('WebKit.WebContent')?'WebContent'
  :command.includes('safaridriver')?'safaridriver'
    :command.includes('Safari')?'Safari'
      :command.includes('wasm-opt')?'wasm-opt'
        :/\bemcc\b|\bclang(?:\+\+)?\b/.test(command)?'compiler':'other'
for(const sample of report.samples??[])for(const process of sample.processes??[]){
  process.category=category(String(process.command??process.executable??''))
  delete process.command
  delete process.executable
}
report.sanitization={rawCommandLinesRemoved:true,retainedFields:['pid','elapsed','residentKiB','cpuPercent','category'],categories:['Safari','WebContent','safaridriver','wasm-opt','compiler','other']}
writeFileSync(path,JSON.stringify(report,null,2)+'\n')
