import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const records={
  '@rolldown/binding-wasm32-wasi@1.2.9':{
    packageJSONSHA256:'363d1db0d1431266551164ae9aa85bbefdcbf798ec68e30d833ca70903a3c13c',
    path:'licenses/upstream/rolldown-binding-wasm32-wasi-1.2.9-LICENSE',
    sha256:'23ecfff35a5a2e80d92142f75228912c3b1abc4b5a8337a821ff4397e2f9f734',
    source:'https://raw.githubusercontent.com/rolldown/rolldown/5b4746e442989d770c606ce08d2737e6aafbd25d/LICENSE',
    revision:'5b4746e442989d770c606ce08d2737e6aafbd25d',
    revisionEvidence:'npm registry SLSA statement resolvedDependencies, signature not independently verified here',
    provenanceURL:'https://registry.npmjs.org/-/npm/v1/attestations/@rolldown/binding-wasm32-wasi@1.2.9',
    provenanceSubjectSHA512:'d9a4df38544782c0e6a55f97e175b01577c8bea242f5a6b0b334ed01e885db967a8c71a9290bde4f9e4c6d0e1301e68811d587bf4537b534eba28857dc9810ef',
  },
  '@napi-rs/wasm-runtime@1.2.4':{
    packageJSONSHA256:'1c67ade399c50710c49bc04f5ad133ae504bf03792df7832eee73d0ecd002045',
    path:'licenses/upstream/napi-rs-wasm-runtime-1.2.4-LICENSE',
    sha256:'3f1ce66533302df3a32edbfdfc0b78f0dd34659e4c1f5817162e5ea3c2297215',
    source:'https://raw.githubusercontent.com/napi-rs/napi-rs/7e3f293e2d6a3032eabfe51ff38bcaa82d342a2f/LICENSE',
    revision:'7e3f293e2d6a3032eabfe51ff38bcaa82d342a2f',
    revisionEvidence:'npm @napi-rs/wasm-runtime@1.2.4 gitHead',
  },
}

// Published packages sometimes omit their upstream notice. Only supplement an
// explicitly reviewed package identity; retain the source and content hashes.
export function supplementalPackageNotice(directory,pkg){
  const record=records[pkg.name+'@'+pkg.version]
  if(!record)return undefined
  if(hash(readFileSync(join(directory,'package.json')))!==record.packageJSONSHA256)throw Error('Supplemental notice package identity changed: '+pkg.name)
  const bytes=readFileSync(new URL('../'+record.path,import.meta.url))
  if(hash(bytes)!==record.sha256)throw Error('Supplemental notice text changed: '+record.path)
  return {...record,bytes:bytes.length,text:bytes.toString('utf8')}
}
