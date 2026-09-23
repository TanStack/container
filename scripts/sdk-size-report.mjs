import {createHash} from 'node:crypto'
import {lstatSync,readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {dirname,join,relative,sep} from 'node:path'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function packageInput(id){
  const marker=sep+'node_modules'+sep,index=id.lastIndexOf(marker)
  if(index<0)return null
  const rest=id.slice(index+marker.length).split(sep),length=rest[0].startsWith('@')?2:1
  const directory=id.slice(0,index+marker.length)+rest.slice(0,length).join(sep)
  const pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'))
  return 'npm/'+pkg.name+'@'+pkg.version+'/'+relative(directory,id).split(sep).join('/')
}

export function buildSDKSizeReport(root,projectRoot,inputIds){
  const files=[]
  function visit(directory=root){for(const name of readdirSync(directory).sort()){
    const path=join(directory,name),stat=lstatSync(path)
    if(stat.isDirectory())visit(path)
    else if(stat.isFile()){
      const output=relative(root,path).split(sep).join('/')
      if(output==='manifest.json'||output==='size-report.json')continue
      const bytes=readFileSync(path);files.push({path:output,bytes:bytes.length,sha256:hash(bytes)})
    }
  }}
  visit()
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
  const bundleInputs=[]
  for(const id of [...inputIds].sort()){
    const path=packageInput(id)??'workspace/'+relative(projectRoot,id).split(sep).join('/')
    if(path.includes('../'))throw Error('SDK bundle input is outside the project: '+id)
    const bytes=readFileSync(id);bundleInputs.push({path,bytes:bytes.length,sha256:hash(bytes)})
  }
  bundleInputs.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
  const byHash=new Map()
  for(const file of files){
    const group=byHash.get(file.sha256)??[]
    group.push(file);byHash.set(file.sha256,group)
  }
  const exactDuplicates=[...byHash.entries()].filter(([,group])=>group.length>1).map(([sha256,group])=>({
    sha256,bytesEach:group[0].bytes,copies:group.length,avoidableBytes:group[0].bytes*(group.length-1),paths:group.map(file=>file.path).sort(),
  })).sort((a,b)=>b.avoidableBytes-a.avoidableBytes||a.sha256.localeCompare(b.sha256))
  const topContributors=[...files].sort((a,b)=>b.bytes-a.bytes||a.path.localeCompare(b.path)).slice(0,20)
  const semanticGroups=new Map()
  for(const file of files.filter(file=>file.path.endsWith('/core.mjs'))){
    const normalized=readFileSync(join(root,file.path),'utf8').replace(/quickjs-stacktrace-[A-Za-z0-9]+/g,'quickjs-stacktrace-ID')
    const normalizedSHA256=hash(normalized),group=semanticGroups.get(normalizedSHA256)??[]
    group.push(file);semanticGroups.set(normalizedSHA256,group)
  }
  const semanticDuplicates=[...semanticGroups.entries()].filter(([,group])=>group.length>1&&new Set(group.map(file=>file.sha256)).size>1).map(([normalizedSHA256,group])=>({
    normalizedSHA256,normalization:'quickjs-stacktrace temporary directory token',bytesEach:group[0].bytes,copies:group.length,avoidableBytes:group[0].bytes*(group.length-1),paths:group.map(file=>file.path).sort(),
  })).sort((a,b)=>b.avoidableBytes-a.avoidableBytes||a.normalizedSHA256.localeCompare(b.normalizedSHA256))
  const distributionPlan=[
    {rank:1,paths:['runtime/compiler/esbuild.wasm'],strategy:'optional compiler asset package',prerequisite:'versioned asset-package export and copy helper; preserve the current runtime/compiler/esbuild.wasm hosted URL',behavior:'compiler worker keeps loading the same URL; consumers that compile install and host the companion asset'},
    {rank:2,paths:['runtime/mvdan-shell/'],strategy:'optional shell asset package',prerequisite:'versioned shell capability and asset-package export; preserve runtime/mvdan-shell URLs',behavior:'runShell and runMvdanShell report a clear missing-capability error unless the matching shell assets are hosted'},
    {rank:3,paths:[...new Set(files.filter(file=>/^runtime\/quickjs-[^/]+\//.test(file.path)).map(file=>file.path.split('/').slice(0,2).join('/')+'/'))].sort(),strategy:'profile-specific runtime asset packages',prerequisite:'explicit host profile selection before kernel construction and exact engine manifest binding',behavior:'each selected profile retains its existing directory URLs and verified engine bytes'},
  ]
  return {format:1,fileBytes:files.reduce((sum,item)=>sum+item.bytes,0),bundleInputBytes:bundleInputs.reduce((sum,item)=>sum+item.bytes,0),duplicateBytes:exactDuplicates.reduce((sum,item)=>sum+item.avoidableBytes,0),semanticDuplicateBytes:semanticDuplicates.reduce((sum,item)=>sum+item.avoidableBytes,0),files,bundleInputs,topContributors,exactDuplicates,semanticDuplicates,distributionPlan}
}

export function writeSDKSizeReport(root,projectRoot,inputIds){
  const report=buildSDKSizeReport(root,projectRoot,inputIds)
  const text=JSON.stringify(report,null,2)+'\n',path='size-report.json'
  writeFileSync(join(root,path),text)
  return {format:1,path,bytes:Buffer.byteLength(text),sha256:hash(text)}
}
