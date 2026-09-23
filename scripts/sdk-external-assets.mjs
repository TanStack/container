import {createHash} from 'node:crypto'
import {lstatSync,readFileSync,readdirSync} from 'node:fs'
import {join,resolve} from 'node:path'

const assert=(condition,message)=>{if(!condition)throw Error(message)}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_@./-]+$/.test(value)&&!value.startsWith('/')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..')
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...expected].sort().join(',')
const identityKeys=['path','package','version','source','sha256']
function identities(assets){
  assert(Array.isArray(assets),'External assets must be an array')
  const seen=new Set()
  for(const item of assets){
    assert(keys(item,identityKeys)&&safe(item.path)&&item.path.startsWith('runtime/')&&safe(item.source)&&
      typeof item.package==='string'&&/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(item.package)&&
      typeof item.version==='string'&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(item.version)&&digest(item.sha256),'Invalid external asset identity')
    assert(!seen.has(item.path),'Duplicate external asset: '+item.path)
    seen.add(item.path)
  }
  return seen
}

// pinnedAssets is trusted build configuration, never taken from the claim.
export function verifyExternalAssetRequirements(claim,{pinnedAssets,packageJSON,packagedPaths}){
  assert(keys(claim,['format','assets'])&&claim.format===1,'Invalid external requirements format')
  identities(pinnedAssets)
  const paths=identities(claim.assets)
  const expected=new Map(pinnedAssets.map(item=>[item.path,item]))
  assert(paths.size===expected.size,'External asset inventory mismatch')
  const packaged=new Set(packagedPaths)
  for(const item of claim.assets){
    const pinned=expected.get(item.path)
    assert(pinned&&identityKeys.every(key=>item[key]===pinned[key]),'External asset pin mismatch: '+item.path)
    assert(packageJSON?.dependencies?.[item.package]===item.version,'External dependency must be exactly pinned: '+item.package)
    assert(!packaged.has(item.path),'External asset must not be packaged: '+item.path)
  }
  return {assets:paths.size}
}

export function verifyDeploymentAssets(directory,manifest,{packageManifestSHA256,expectedFiles}){
  assert(keys(manifest,['format','packageManifestSHA256','files'])&&manifest.format===1,'Invalid deployment manifest')
  assert(digest(packageManifestSHA256)&&manifest.packageManifestSHA256===packageManifestSHA256,'Deployment package manifest binding mismatch')
  const validate=files=>{
    assert(Array.isArray(files),'Deployment files must be an array')
    const map=new Map()
    for(const item of files){
      assert(keys(item,['path','bytes','sha256'])&&safe(item.path)&&item.path!=='deployment-manifest.json'&&Number.isSafeInteger(item.bytes)&&item.bytes>=0&&digest(item.sha256),'Invalid deployment file')
      assert(!map.has(item.path),'Duplicate deployment file: '+item.path)
      map.set(item.path,item)
    }
    return map
  }
  const expected=validate(expectedFiles),claimed=validate(manifest.files)
  assert(expected.size===claimed.size,'Deployment inventory mismatch')
  for(const[path,item]of expected){const actual=claimed.get(path);assert(actual&&actual.bytes===item.bytes&&actual.sha256===item.sha256,'Deployment file claim mismatch: '+path)}
  const root=resolve(directory),rootStat=lstatSync(root)
  assert(rootStat.isDirectory()&&!rootStat.isSymbolicLink(),'Deployment root must be a real directory')
  const found=new Set()
  const visit=relative=>{
    for(const name of readdirSync(join(root,relative))){
      const path=relative?relative+'/'+name:name,stat=lstatSync(join(root,path))
      assert(safe(path)&&!stat.isSymbolicLink(),'Unsafe deployment entry: '+path)
      if(stat.isDirectory()){visit(path);continue}
      assert(stat.isFile(),'Unsupported deployment entry: '+path)
      if(path==='deployment-manifest.json'){
        assert(JSON.stringify(JSON.parse(readFileSync(join(root,path),'utf8')))===JSON.stringify(manifest),'Deployment manifest on disk differs')
        continue
      }
      const item=expected.get(path)
      assert(item,'Unexpected deployment file: '+path)
      const bytes=readFileSync(join(root,path))
      assert(bytes.length===item.bytes&&hash(bytes)===item.sha256,'Deployment asset mismatch: '+path)
      found.add(path)
    }
  }
  visit('')
  assert(found.size===expected.size,'Missing deployment asset')
  return {files:found.size}
}
