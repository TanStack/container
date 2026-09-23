import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {existsSync,readFileSync,readdirSync,realpathSync,statSync,writeFileSync} from 'node:fs'
import {dirname,join,relative,resolve,sep} from 'node:path'
import {fileURLToPath} from 'node:url'

const noticeName=/^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const pinnedRevision='5b4746e442989d770c606ce08d2737e6aafbd25d'

export function verifyRolldownSourceIdentity(sourceRoot){
  const root=realpathSync(resolve(sourceRoot))
  const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()
  assert.equal(revision,pinnedRevision,'Rolldown source is not the pinned binding revision')
  const tracked=execFileSync('git',['ls-files','Cargo.lock','LICENSE',':(glob)**/Cargo.toml'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean).sort()
  assert.ok(tracked.includes('Cargo.lock')&&tracked.includes('LICENSE')&&tracked.some(path=>path.endsWith('Cargo.toml')),'Pinned Rolldown source inputs are incomplete')
  const status=execFileSync('git',['status','--porcelain','--untracked-files=all','--','Cargo.lock','LICENSE',':(glob)**/Cargo.toml'],{cwd:root,encoding:'utf8'}).trim()
  assert.equal(status,'','Rolldown Cargo manifests, lockfile, or repository license differ from the pinned revision')
  const digest=createHash('sha256')
  for(const path of tracked)digest.update(path).update('\0').update(readFileSync(join(root,path))).update('\0')
  return {revision,inputsSHA256:digest.digest('hex'),cargoLockSHA256:hash(readFileSync(join(root,'Cargo.lock'))),repositoryLicenseSHA256:hash(readFileSync(join(root,'LICENSE'))),trackedInputs:tracked.length}
}

export function reachablePackages(metadata,rootName='rolldown_binding'){
  const packages=new Map(metadata.packages.map(pkg=>[pkg.id,pkg]))
  const nodes=new Map((metadata.resolve?.nodes??[]).map(node=>[node.id,node]))
  const roots=[...packages.values()].filter(pkg=>pkg.name===rootName)
  assert.equal(roots.length,1,`Expected one Cargo package named ${rootName}`)
  const seen=new Set(),queue=[roots[0].id]
  while(queue.length){
    const id=queue.shift()
    if(seen.has(id))continue
    seen.add(id)
    for(const dependency of nodes.get(id)?.deps??[]){
      if((dependency.dep_kinds??[]).some(kind=>kind.kind!=='dev'))queue.push(dependency.pkg)
    }
  }
  return [...seen].map(id=>packages.get(id)).filter(Boolean)
}

export function packageNotices(pkg,sourceRoot,repositoryLicense){
  const packageRoot=dirname(pkg.manifest_path),files=[]
  if(pkg.license_file){
    const path=resolve(packageRoot,pkg.license_file)
    if(existsSync(path)&&statSync(path).isFile())files.push(path)
  }
  for(const name of readdirSync(packageRoot).sort()){
    const path=join(packageRoot,name)
    if(noticeName.test(name)&&statSync(path).isFile()&&!files.includes(path))files.push(path)
  }
  const workspace=!pkg.source&&realpathSync(packageRoot).startsWith(realpathSync(sourceRoot)+sep)
  if(workspace&&!files.length)files.push(repositoryLicense)
  return {
    workspace,
    notices:files.map(path=>{
      const bytes=readFileSync(path)
      return {path:workspace&&path===repositoryLicense?'LICENSE':relative(packageRoot,path).split(sep).join('/'),sha256:hash(bytes),bytes:bytes.length}
    }),
  }
}

function packageProvenance(pkg){
  const path=join(dirname(pkg.manifest_path),'.cargo_vcs_info.json')
  if(!existsSync(path))return {repository:pkg.repository??null,vcs:null}
  const record=JSON.parse(readFileSync(path,'utf8'))
  return {repository:pkg.repository??null,vcs:{sha1:record.git?.sha1??null,path:record.path_in_vcs??null,recordSHA256:hash(readFileSync(path))}}
}

export function buildRolldownRustNoticeInventory(metadata,sourceRoot,sourceIdentity){
  const root=realpathSync(resolve(sourceRoot)),repositoryLicense=join(root,'LICENSE')
  assert.ok(existsSync(repositoryLicense),'Pinned Rolldown source is missing its repository LICENSE')
  assert.equal(sourceIdentity?.revision,pinnedRevision,'A verified pinned Rolldown source identity is required')
  assert.equal(sourceIdentity.repositoryLicenseSHA256,hash(readFileSync(repositoryLicense)),'Rolldown repository license changed after source verification')
  const packages=reachablePackages(metadata).sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version)||a.id.localeCompare(b.id))
  const records=packages.map(pkg=>{
    const found=packageNotices(pkg,root,repositoryLicense)
    return {name:pkg.name,version:pkg.version,source:pkg.source??'workspace',license:pkg.license??null,licenseFile:pkg.license_file??null,...packageProvenance(pkg),...found}
  })
  return {
    format:1,
    scope:{rootPackage:'rolldown_binding',target:'wasm32-wasip1-threads',dependencyKinds:['normal','build'],exactLinkedContents:false,reason:'Cargo metadata includes workspace-unified features and build dependencies, so this is an overinclusive review set.'},
    source:sourceIdentity,
    packages:records,
    summary:{packages:records.length,workspace:records.filter(record=>record.workspace).length,withNotice:records.filter(record=>record.notices.length).length,missingNotice:records.filter(record=>!record.notices.length).length},
  }
}

function cargoMetadata(sourceRoot){
  return JSON.parse(execFileSync('cargo',['+stable','metadata','--offline','--locked','--format-version','1','--filter-platform','wasm32-wasip1-threads'],{
    cwd:sourceRoot,encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,CARGO_NET_OFFLINE:'true'},
  }))
}

const invoked=process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)
if(invoked){
  assert.ok(process.argv.length===3||process.argv.length===4,'Usage: node scripts/rolldown-rust-notice-inventory.mjs SOURCE [OUTPUT.json]')
  const source=realpathSync(resolve(process.argv[2])),sourceIdentity=verifyRolldownSourceIdentity(source)
  const inventory=buildRolldownRustNoticeInventory(cargoMetadata(source),source,sourceIdentity)
  const json=JSON.stringify(inventory,null,2)+'\n'
  if(process.argv[3])writeFileSync(resolve(process.argv[3]),json,{flag:'wx'})
  else process.stdout.write(json)
}
