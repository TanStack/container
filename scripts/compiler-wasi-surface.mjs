import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {WASI} from '../src/sandbox/guest-wasi.js'

const supported=new Set(Object.keys(new WASI({version:'preview1'}).wasiImport))
const cases=[
  ['fixtures/compiler-wasi','@rolldown/binding-wasm32-wasi','rolldown-binding.wasm32-wasi.wasm'],
  ['fixtures/compiler-wasi-astro','@astrojs/compiler-binding-wasm32-wasi','astro.wasm32-wasi.wasm'],
]
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex')
const report={scope:'Import-name inventory only, not behavior or thread compatibility.',cases:cases.map(([root,name,file])=>{
  const directory=root+'/node_modules/'+name
  const manifest=JSON.parse(readFileSync(directory+'/package.json','utf8'))
  const bytes=readFileSync(directory+'/'+file)
  const imports=WebAssembly.Module.imports(new WebAssembly.Module(bytes))
  const wasi=imports.filter(entry=>entry.module==='wasi_snapshot_preview1').map(entry=>entry.name).sort()
  return {name,version:manifest.version,root,lockSHA256:sha256(readFileSync(root+'/package-lock.json')),wasmSHA256:sha256(bytes),imports,
    presentWASI:wasi.filter(name=>supported.has(name)),missingWASI:wasi.filter(name=>!supported.has(name))}
})}
writeFileSync('reports/compiler-wasi-surface.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report.cases.map(({name,presentWASI,missingWASI})=>({name,present:presentWASI.length,missing:missingWASI})),null,2))
