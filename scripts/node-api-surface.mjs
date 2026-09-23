import {builtinModules as nativeBuiltinModules} from 'node:module'
import {createHash} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import path from 'node:path'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const artifactPath=path.join(root,'public/kernel-runtime/builtins.json')
const jsonPath=path.join(root,'reports/node-api-surface.json')
const markdownPath=path.join(root,'reports/node-api-surface.md')
const warning='Export-name coverage only measures API shape. It does not prove that an export matches native Node behavior.'
const sorted=values=>[...values].sort((a,b)=>a.localeCompare(b,'en'))
const publicName=value=>{
  const name=value.startsWith('node:')?value.slice(5):value
  if(name==='sys'||name.startsWith('_')||name.startsWith('internal/'))return null
  return name
}

export async function generateNodeAPISurface(){
  const artifactBytes=await readFile(artifactPath)
  const artifact=JSON.parse(artifactBytes.toString('utf8'))
  const nativeModules=sorted(new Set(nativeBuiltinModules.map(publicName).filter(Boolean)))
  const supportedModules=sorted(Object.keys(artifact.modules).map(publicName).filter(Boolean))
  const nativeSet=new Set(nativeModules),supportedSet=new Set(supportedModules)
  const modules=[]
  for(const name of supportedModules){
    const nativeExports=nativeSet.has(name)?sorted(Object.keys(await import('node:'+name))):[]
    const runtimeExports=sorted(artifact.modules['node:'+name]?.exports??[])
    const nativeExportSet=new Set(nativeExports),runtimeExportSet=new Set(runtimeExports)
    modules.push({
      module:'node:'+name,
      present:runtimeExports.filter(value=>nativeExportSet.has(value)),
      missing:nativeExports.filter(value=>!runtimeExportSet.has(value)),
      extra:runtimeExports.filter(value=>!nativeExportSet.has(value)),
    })
  }
  return {
    schemaVersion:1,
    nativeRuntime:process.version,
    runtimeArtifactVersion:artifact.version,
    runtimeArtifactSHA256:createHash('sha256').update(artifactBytes).digest('hex'),
    warning,
    nativePublicModuleCount:nativeModules.length,
    supportedModuleCount:supportedModules.length,
    missingPublicModules:nativeModules.filter(value=>!supportedSet.has(value)).map(value=>'node:'+value),
    modules,
  }
}

export function renderNodeAPISurface(report){
  const names=values=>values.length?values.map(value=>'`'+value+'`').join(', '):'None'
  const lines=[
    '# Node API surface inventory','',
    `Native control: ${report.nativeRuntime}`,'',
    `Runtime artifact: ${report.runtimeArtifactVersion}`,'',
    `Runtime artifact SHA-256: ${report.runtimeArtifactSHA256}`,'',
    `Supported public modules: ${report.supportedModuleCount} of ${report.nativePublicModuleCount}`,'',
    `**Warning:** ${report.warning}`,'',
    '## Missing public modules','',
    ...report.missingPublicModules.map(name=>'- `'+name+'`'),'',
    '## Supported module exports','',
    '| Module | Present exports | Missing exports | Extra exports |',
    '| --- | --- | --- | --- |',
    ...report.modules.map(row=>`| \`${row.module}\` | ${names(row.present)} | ${names(row.missing)} | ${names(row.extra)} |`),
    '',
  ]
  return lines.join('\n')
}

export async function writeNodeAPISurface(){
  const report=await generateNodeAPISurface()
  await writeFile(jsonPath,JSON.stringify(report,null,2)+'\n')
  await writeFile(markdownPath,renderNodeAPISurface(report))
  return report
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=await writeNodeAPISurface()
  console.log(JSON.stringify({nativeRuntime:report.nativeRuntime,supported:report.supportedModuleCount,missing:report.missingPublicModules.length}))
}
