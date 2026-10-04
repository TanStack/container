import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const records={
  '@tybys/wasm-util@0.10.2':{
    packageJSONSHA256:'a7b1718e6616ae2cd235a365d03b8d5b5e8c5d6a27e9f7604a3d51ed20ca9c29',
    path:'licenses/upstream/tybys-wasm-util-0.10.2-LICENSE',
    sha256:'09e436100bf926e78df875ec80cf3d0c643dfec779b52cfe2aa96afa0de714cb',
    source:'https://raw.githubusercontent.com/toyobayashi/wasm-util/a16b188d44ae43cc91edb71996ba2b43ff0996d9/LICENSE',
    revision:'a16b188d44ae43cc91edb71996ba2b43ff0996d9',
    releaseRevision:'cded8e894fe40c7c6200a3fdb2bd33e328b7bb65',
    revisionEvidence:'Maintainer license-addition commit, four commits after npm 0.10.2 gitHead, not a license file shipped in that release',
  },
  'glob-to-regex.js@1.2.0':{
    packageJSONSHA256:'ab1588b90924419f4af8daa28343972335b6edb26438c8eb0653e7893a4ad4f1',
    path:'licenses/upstream/apache-2.0-LICENSE',
    sha256:'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    source:'https://www.apache.org/licenses/LICENSE-2.0.txt',
    revision:'Apache-2.0',
    releaseRevision:'bd39c83a44f5a5a2cf1a8bdd7996658c6b93368c',
    revisionEvidence:'Official Apache license text for the exact package declaration, with original README attribution preserved',
    attribution:{path:'README.md',text:'Apache-2.0 © streamich'},
  },
  "@napi-rs/wasm-runtime@1.1.4":{
    "packageJSONSHA256": "5f9db850fde3b2adaf40343485598ad1606d5177748c4cdede5ddc8696940ab1",
    "path": "licenses/upstream/napi-rs-wasm-runtime-1.1.4-LICENSE",
    "sha256": "3f1ce66533302df3a32edbfdfc0b78f0dd34659e4c1f5817162e5ea3c2297215",
    "source": "https://raw.githubusercontent.com/napi-rs/napi-rs/d5c3c43b45393f99ba151770f97bd472de533671/LICENSE",
    "revision": "d5c3c43b45393f99ba151770f97bd472de533671",
    "revisionEvidence": "npm @napi-rs/wasm-runtime@1.1.4 gitHead"
  },
  "lightningcss-wasm@1.32.0":{
    "packageJSONSHA256": "b7f16ae6a0036f2d92a22efdfff34482ec6b9ef33c519b8c0e858dbf2d403410",
    "path": "licenses/upstream/lightningcss-MPL-2.0-LICENSE",
    "sha256": "5eba353fe5076ac3432177f8ab1cf75e3afcd0584251e37c3bfead5f447d040e",
    "source": "https://raw.githubusercontent.com/parcel-bundler/lightningcss/7f8a861bdee476fe90c89a8badeb3fd33a99c51a/LICENSE",
    "revision": "7f8a861bdee476fe90c89a8badeb3fd33a99c51a",
    "revisionEvidence": "npm lightningcss-wasm@1.32.0 gitHead"
  },
  "lightningcss-wasm@1.33.0":{
    "packageJSONSHA256": "406afdbb1af94415febaaf6d1c03c28ad7005305f04d260db59d59a3cb27911e",
    "path": "licenses/upstream/lightningcss-MPL-2.0-LICENSE",
    "sha256": "5eba353fe5076ac3432177f8ab1cf75e3afcd0584251e37c3bfead5f447d040e",
    "source": "https://raw.githubusercontent.com/parcel-bundler/lightningcss/1d680fa14e9a089c92dc0929f869d6757ae91c30/LICENSE",
    "revision": "1d680fa14e9a089c92dc0929f869d6757ae91c30",
    "revisionEvidence": "npm lightningcss-wasm@1.33.0 gitHead"
  },
  "@tailwindcss/oxide-wasm32-wasi@4.3.3":{
    "packageJSONSHA256": "992d12fdcbea73c338441142f7d629ac22561c3d25c72fa8ca93768353a5947f",
    "path": "licenses/upstream/tailwindcss-oxide-wasm32-wasi-4.3.3-LICENSE",
    "sha256": "60e0b68c0f35c078eef3a5d29419d0b03ff84ec1df9c3f9d6e39a519a5ae7985",
    "source": "https://raw.githubusercontent.com/tailwindlabs/tailwindcss/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d/LICENSE",
    "revision": "c2b24dd15fed1c59dd521bd86082f520c9f5ad0d",
    "revisionEvidence": "npm registry SLSA statement resolvedDependencies, signature not independently verified here",
    "provenanceURL": "https://registry.npmjs.org/-/npm/v1/attestations/@tailwindcss%2foxide-wasm32-wasi@4.3.3",
    "provenanceSubjectSHA512": "8f1d7eacf858ff9626a6492d77ae7a1c158404bc4fedd1f4ea5a2c04b8e37f9be008e0d7be2f4a86d7ed59c308c131480ea06bedc46742474b9c01be20e946bd"
  },
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
  let attribution=''
  if(record.attribution){
    const source=readFileSync(join(directory,record.attribution.path),'utf8')
    if(!source.split(/\r?\n/).includes(record.attribution.text))throw Error('Supplemental notice package attribution changed: '+pkg.name)
    attribution=record.attribution.text+'\n\n'
  }
  return {...record,bytes:bytes.length,text:attribution+bytes.toString('utf8')}
}
