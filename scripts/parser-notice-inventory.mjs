import {readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {supplementalPackageNotice} from './supplemental-package-notices.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const packageName=path=>path.startsWith('@')?path.split('/').slice(0,2).join('/'):path.split('/')[0]

// Records installed package evidence and pinned supplemental notices. This
// does not establish complete embedded dependency coverage or legal clearance.
export function parserNoticeInventory(dependencyRoot,artifact){
  const lockBytes=readFileSync(join(dependencyRoot,'package-lock.json'))
  if(hash(lockBytes)!==artifact.lockSHA256)throw Error('Parser notice lock does not match artifact')
  const lock=JSON.parse(lockBytes),sources=new Map()
  const add=(path,expected)=>{
    if(path.startsWith('/')||path.split('/').some(part=>!part||part==='..'||part==='.')||path.includes('\\'))throw Error('Invalid parser notice input path')
    const actual=hash(readFileSync(join(dependencyRoot,'node_modules',path)))
    if(actual!==expected)throw Error('Parser notice input hash mismatch: '+path)
    const name=packageName(path)
    if(!sources.has(name))sources.set(name,{})
    sources.get(name)[path.slice(name.length+1)]=actual
  }
  for(const [path,sha256]of Object.entries(artifact.inputs))add(path,sha256)
  for(const [path,sha256]of Object.entries(artifact.sources))if(path.startsWith('npm/'))add(path.slice(4),sha256)
  if(!sources.has('rolldown'))sources.set('rolldown',{})
  const packages=[...sources].sort(([a],[b])=>a.localeCompare(b)).map(([name,files])=>{
    const directory=join(dependencyRoot,'node_modules',name)
    const manifestBytes=readFileSync(join(directory,'package.json')),manifest=JSON.parse(manifestBytes)
    const entry=lock.packages['node_modules/'+name]
    if(manifest.name!==name||!entry||entry.version!==manifest.version)throw Error('Parser notice package identity mismatch: '+name)
    const notices=readdirSync(directory,{withFileTypes:true}).filter(file=>/^(license|licence|copying|notice|third-party-license)([._-]|$)/i.test(file.name)).sort((a,b)=>a.name.localeCompare(b.name)).map(file=>{
      if(!file.isFile())throw Error('Expected regular parser notice: '+name+'/'+file.name)
      const bytes=readFileSync(join(directory,file.name))
      return {path:file.name,sha256:hash(bytes),bytes:bytes.length}
    })
    const supplemental=notices.length?undefined:supplementalPackageNotice(directory,manifest)
    if(supplemental){const {text,...provenance}=supplemental;notices.push({...provenance,location:'upstream-source'})}
    return {name,version:manifest.version,declaredLicense:manifest.license??null,
      packageJSONSHA256:hash(manifestBytes),repository:manifest.repository??null,
      lockedArchive:{url:entry.resolved??null,integrity:entry.integrity??null,verifiedHere:false},
      inputs:files,notices,noticeStatus:supplemental?'upstream-notice-present':notices.length?'package-files-present':'missing-package-notice-text'}
  })
  return {format:1,scope:'Pinned installed package files, metadata, and explicitly identified upstream notices. Archive integrity is recorded from the lock, not reverified here. Package repository metadata alone is not a verified source revision.',
    lockSHA256:artifact.lockSHA256,parserVersion:artifact.version,artifactAssets:artifact.assets,packages,
    complete:false,unverified:['Embedded Rust dependency notice coverage inside parser.wasm.','Transitive code bundled inside published JavaScript packages is not fully inventoried by package-level metadata.']}
}
