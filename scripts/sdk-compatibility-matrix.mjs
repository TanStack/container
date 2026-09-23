import {existsSync,readFileSync,writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,relative,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'

const root=resolve(import.meta.dirname,'..')
const packageNames=['@rollup/wasm-node','@sveltejs/kit','@tanstack/react-start','esbuild','esbuild-wasm','rollup','vite','vitest']
const lockfiles=[
  'package-lock.json',
  'fixtures/install-esbuild-wasm/package-lock.json',
  'fixtures/install-start-portable/package-lock.json',
  'fixtures/install-start-wasm/package-lock.json',
  'fixtures/install-start/package-lock.json',
  'fixtures/install-sveltekit-wasm/package-lock.json',
  'fixtures/install-vitest/package-lock.json',
  'fixtures/workloads/package-lock.json',
]

const json=file=>JSON.parse(readFileSync(resolve(root,file),'utf8'))
const packageName=(path,entry)=>entry.name??path.replace(/^node_modules\//,'')
const installedPackage=(lockfile,path)=>resolve(root,dirname(lockfile),path,'package.json')

export function discoverCompatibilityPackages(){
  const rows=[]
  for(const lockfile of lockfiles){
    const lock=json(lockfile)
    if(!lock.packages||lock.lockfileVersion<2)throw Error(`Compatibility discovery requires a physical package tree in ${lockfile}`)
    for(const [path,entry] of Object.entries(lock.packages)){
      const name=packageName(path,entry)
      if(!packageNames.includes(name)||!entry.version)continue
      const disk=installedPackage(lockfile,path)
      let installed=null
      if(existsSync(disk)){
        const manifest=JSON.parse(readFileSync(disk,'utf8'))
        installed={name:manifest.name,version:manifest.version,path:relative(root,disk)}
        if(manifest.name!==name||manifest.version!==entry.version)throw Error(`Installed package differs from ${lockfile}: ${path}`)
      }
      rows.push({lockfile,path,name,version:entry.version,installed})
    }
  }
  return rows.sort((a,b)=>[a.name,a.version,a.lockfile,a.path].join('\0').localeCompare([b.name,b.version,b.lockfile,b.path].join('\0')))
}

function runProbe(row){
  if(!row.installed)return {status:'not-run',reason:'package is locked but not installed locally'}
  const packageRoot=dirname(resolve(root,row.installed.path))
  const require=createRequire(resolve(packageRoot,'package.json'))
  const manifest=JSON.parse(readFileSync(resolve(packageRoot,'package.json'),'utf8'))
  const exported=manifest.exports?.['.']
  const exportTarget=value=>typeof value==='string'?value:value&&exportTarget(value.import??value.node??value.default)
  const entry=resolve(packageRoot,exportTarget(exported)??manifest.module??manifest.main??'index.js')
  try{
    if(row.name==='esbuild'||row.name==='esbuild-wasm'){
      const api=require(packageRoot)
      const result=api.transformSync('const answer: number = 42',{loader:'ts'})
      if(!result.code.includes('42')||result.code.includes(': number'))throw Error('TypeScript transform output mismatch')
      return {status:'passed',gate:'native API transform'}
    }
    if(row.name==='rollup'||row.name==='@rollup/wasm-node'){
      const script=`import {rollup} from ${JSON.stringify(pathToFileURL(entry).href)};const b=await rollup({input:'entry',plugins:[{name:'fixture',resolveId:x=>x==='entry'?x:null,load:x=>x==='entry'?'export const answer=42':null}]});const o=await b.generate({format:'es'});if(!o.output[0].code.includes('42'))throw Error('missing output');await b.close()`
      const run=spawnSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8',timeout:30000})
      if(run.status!==0)throw Error((run.stderr||run.stdout||`exit ${run.status}`).trim())
      return {status:'passed',gate:'native API bundle'}
    }
    if(row.name==='vite'){
      const script=`import * as api from ${JSON.stringify(pathToFileURL(entry).href)};if(api.version!==${JSON.stringify(row.version)}||typeof api.transformWithEsbuild!=='function')throw Error('Vite API/version mismatch')`
      const run=spawnSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8',timeout:30000})
      if(run.status!==0)throw Error((run.stderr||run.stdout||`exit ${run.status}`).trim())
      return {status:'passed',gate:'native API load'}
    }
    if(row.name==='vitest'){
      const bin=resolve(packageRoot,typeof manifest.bin==='string'?manifest.bin:manifest.bin.vitest)
      const run=spawnSync(process.execPath,[bin,'--version'],{cwd:dirname(resolve(root,row.installed.path)),encoding:'utf8',timeout:30000})
      if(run.status!==0||!run.stdout.includes(row.version))throw Error((run.stderr||run.stdout||`exit ${run.status}`).trim())
      return {status:'passed',gate:'native CLI load'}
    }
    return {status:'passed',gate:'static package manifest',reason:'framework execution is covered only by queued SDK browser cases'}
  }catch(error){return {status:'failed',gate:'native probe',reason:String(error)} }
}

function fixtureVersions(lockfile){
  return Object.fromEntries(discoverCompatibilityPackages().filter(row=>row.lockfile===lockfile).map(row=>[row.name,row.version]))
}

export function buildCompatibilityMatrix({runNative=true}={}){
  const discovered=discoverCompatibilityPackages()
  const installed=discovered.filter(row=>row.installed)
  const uniqueInstalled=new Map(installed.map(row=>[`${row.installed.path}\0${row.name}`,row]))
  const gates=[...uniqueInstalled.values()].map(row=>({...row,static:{status:'passed',gate:'lockfile and installed manifest agree'},native:runNative?runProbe(row):{status:'not-run',reason:'native gates disabled'}}))
  const browserQueue=[
    {id:'sdk-start',spec:'tests/sdk-frameworks/start-consumer.spec.ts',fixture:'fixtures/install-start-wasm',versions:fixtureVersions('fixtures/install-start-wasm/package-lock.json'),status:'queued'},
    {id:'sdk-sveltekit',spec:'tests/sdk-frameworks/sveltekit-consumer.spec.ts',fixture:'fixtures/install-sveltekit-wasm',versions:fixtureVersions('fixtures/install-sveltekit-wasm/package-lock.json'),status:'queued'},
    {id:'sdk-vite',spec:'tests/sdk/vite-consumer.spec.ts',fixture:'fixtures/install-start-wasm',versions:fixtureVersions('fixtures/install-start-wasm/package-lock.json'),status:'queued'},
    {id:'sdk-vitest',spec:'tests/install-wasm/vitest.spec.ts',fixture:'fixtures/install-vitest',versions:fixtureVersions('fixtures/install-vitest/package-lock.json'),status:'queued'},
  ]
  return {format:1,scope:'Local lockfiles and installed packages only. Native/static gates do not imply SDK browser compatibility. Queued browser cases are not passes.',lockfiles,packages:packageNames,discovered,gates,browserQueue}
}

function markdown(report){
  const lines=['# Ordinary package compatibility matrix','',report.scope,'','## Native and static gates','','| Package | Version | Local source | Static | Native |','| --- | --- | --- | --- | --- |']
  for(const row of report.gates)lines.push(`| ${row.name} | ${row.version} | ${row.lockfile} | ${row.static.status} | ${row.native.status}: ${row.native.gate??row.native.reason} |`)
  lines.push('','## Queued SDK browser cases','','These cases are wired to existing specs and exact local fixture locks. They remain queued until Playwright runs them.','','| Case | Fixture versions | Browsers | Status |','| --- | --- | --- | --- |')
  for(const row of report.browserQueue)lines.push(`| ${row.id} | ${Object.entries(row.versions).map(([name,version])=>`${name}@${version}`).join(', ')} | Chromium, Firefox, WebKit | ${row.status} |`)
  lines.push('','## Locked but unavailable locally','','These versions are discovery results, not tested claims. They have no installed package directory for a native gate.','')
  for(const row of report.discovered.filter(row=>!row.installed))lines.push(`- ${row.name}@${row.version}, ${row.lockfile}`)
  return lines.join('\n')+'\n'
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
  const report=buildCompatibilityMatrix({runNative:!process.argv.includes('--static-only')})
  if(process.argv.includes('--write')){
    writeFileSync(resolve(root,'reports/sdk-package-compatibility.json'),JSON.stringify(report,null,2)+'\n')
    writeFileSync(resolve(root,'reports/sdk-package-compatibility.md'),markdown(report))
  }
  console.log(JSON.stringify({discovered:report.discovered.length,gates:report.gates.length,passed:report.gates.filter(row=>row.static.status==='passed'&&row.native.status==='passed').length,failed:report.gates.filter(row=>row.native.status==='failed').length,queued:report.browserQueue.length},null,2))
  if(report.gates.some(row=>row.native.status==='failed'))process.exitCode=1
}
