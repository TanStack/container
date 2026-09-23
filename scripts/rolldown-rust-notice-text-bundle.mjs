import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {packageNotices,reachablePackages,verifyRolldownSourceIdentity} from './rolldown-rust-notice-inventory.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')

export function buildRolldownRustNoticeTextBundle(metadata,sourceRoot){
  const root=realpathSync(resolve(sourceRoot)),repositoryLicense=join(root,'LICENSE'),byHash=new Map()
  for(const pkg of reachablePackages(metadata).sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version))){
    const found=packageNotices(pkg,root,repositoryLicense),packageRoot=dirname(pkg.manifest_path)
    for(const notice of found.notices){
      const candidate=join(packageRoot,notice.path),path=found.workspace&&notice.path==='LICENSE'&&!existsSync(candidate)?repositoryLicense:candidate
      const bytes=readFileSync(path)
      assert.equal(hash(bytes),notice.sha256,`Cargo notice changed while bundling ${pkg.name}@${pkg.version}`)
      const existing=byHash.get(notice.sha256)??{sha256:notice.sha256,text:bytes.toString('utf8').trimEnd(),usedBy:[]}
      existing.usedBy.push(`${pkg.name}@${pkg.version}:${notice.path}`)
      byHash.set(notice.sha256,existing)
    }
  }
  const records=[...byHash.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256))
  const sections=records.map(record=>[`SHA-256: ${record.sha256}`,'Used by:',...record.usedBy.sort().map(item=>'  '+item),'',record.text].join('\n'))
  return {text:['Rolldown Rust dependency notice texts','Scope: overinclusive non-development Cargo metadata graph, not exact linked-code evidence.','',...sections].join('\n\n')+'\n',notices:records.length,attributions:records.reduce((sum,record)=>sum+record.usedBy.length,0)}
}

function cargoMetadata(sourceRoot){
  return JSON.parse(execFileSync('cargo',['+stable','metadata','--offline','--locked','--format-version','1','--filter-platform','wasm32-wasip1-threads'],{cwd:sourceRoot,encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,CARGO_NET_OFFLINE:'true'}}))
}

const invoked=process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)
if(invoked){
  assert.equal(process.argv.length,4,'Usage: node scripts/rolldown-rust-notice-text-bundle.mjs SOURCE OUTPUT.txt')
  const source=realpathSync(resolve(process.argv[2]));verifyRolldownSourceIdentity(source)
  const bundle=buildRolldownRustNoticeTextBundle(cargoMetadata(source),source)
  writeFileSync(resolve(process.argv[3]),bundle.text,{flag:'wx'})
  process.stdout.write(JSON.stringify({sha256:hash(bundle.text),bytes:Buffer.byteLength(bundle.text),notices:bundle.notices,attributions:bundle.attributions},null,2)+'\n')
}
