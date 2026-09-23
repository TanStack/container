import {mkdtempSync,mkdirSync,cpSync,readFileSync,writeFileSync,readdirSync,lstatSync} from 'node:fs'
import {join,resolve,dirname,relative} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {verifySDK} from './verify-sdk.mjs'
import {buildSDKAPIContract} from './sdk-api-contract.mjs'
import {buildRolldownAdapter} from './build-rolldown-parser.mjs'
import {requiredDependencies} from '../src/sdk/compiler-assets.mjs'
import {verifySourceSnapshot} from './source-snapshot.mjs'
import {isAlphaSDKVersion} from './sdk-license-policy.mjs'

const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=path=>JSON.parse(readFileSync(path,'utf8'))
const writeJSON=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n')
function copy(source,target){mkdirSync(dirname(target),{recursive:true});cpSync(source,target,{recursive:true,errorOnExist:true,force:false})}
function manifest(root){
  const files=[]
  function visit(directory){for(const name of readdirSync(directory).sort()){
    const path=join(directory,name),stat=lstatSync(path)
    if(stat.isSymbolicLink())throw Error('Unexpected package symlink: '+path)
    if(stat.isDirectory())visit(path)
    else if(stat.isFile()){const bytes=readFileSync(path);files.push({path:relative(root,path).replaceAll('\\','/'),bytes:bytes.length,sha256:hash(bytes)})}
    else throw Error('Unsupported package entry: '+path)
  }}
  visit(root);writeJSON(join(root,'package-assets.json'),{format:1,files})
}

// Upstream compiler binaries belong to installed dependencies. Only deployment
// setup may assemble them into browser assets, not the published packages.
export function verifyCompilerPackageBoundary(core,runtime){
  for(const root of [core,runtime]){
    const {files}=json(join(root,'package-assets.json'))
    for(const {path} of files){
      assert.ok(!path.startsWith('node_modules/')&&
        !path.startsWith('runtime/rolldown-parser/')&&
        !['esbuild.wasm','rolldown-binding.wasm32-wasi.wasm'].includes(path.split('/').at(-1)),
      'Upstream compiler assets must remain npm dependencies: '+path)
    }
  }
  const dependencies=json(join(runtime,'package.json')).dependencies
  for(const [name,version] of Object.entries(requiredDependencies)){
    assert.equal(dependencies?.[name],version,'Missing pinned compiler dependency: '+name)
  }
}

/** Bind source-added split helpers to the archive already recorded by staging. */
export function verifySDKPackageSources(staging,{sourceArchive,projectRoot=sourceRoot}={}){
  const record=json(join(staging,'release-record.json')),pkg=json(join(staging,'package.json'))
  assert.equal(record.format,1,'Unsupported staging release record')
  const source=record.source
  if(source?.kind==='unavailable'){
    assert.ok(pkg.private===true&&pkg.version==='0.0.0','Release staging requires a bound source archive')
    assert.equal(source.revision,null,'Unverified staging must not claim a source revision')
    assert.equal(source.archive,null,'Unverified staging must not claim a source archive')
    assert.ok(!sourceArchive,'Cannot add source provenance during splitting; rebuild staging with SDK_SOURCE_ARCHIVE')
    return {status:'unverified',reason:'Private development staging has no bound source archive',source}
  }
  assert.equal(source?.kind,'source-archive','Staging source provenance is missing or unsupported')
  assert.ok(typeof sourceArchive==='string'&&sourceArchive,'SDK_SOURCE_ARCHIVE is required for source-bound staging')
  const bytes=readFileSync(sourceArchive),digest=hash(bytes)
  assert.equal(source.revision,'sha256:'+digest,'Split source archive differs from staging source revision')
  assert.equal(source.archive?.sha256,digest,'Split source archive differs from staging archive hash')
  assert.equal(source.archive?.bytes,bytes.length,'Split source archive size differs from staging')
  const verified=verifySourceSnapshot(projectRoot,sourceArchive)
  return {status:'verified',source,tarSHA256:verified.tarSHA256,files:verified.files}
}

/** Select packaging metadata only. This does not approve or publish a release. */
export function resolveSDKPackageFormat(staging,{publicationCandidate=false,sourceBinding,projectRoot=sourceRoot}={}){
  assert.equal(typeof publicationCandidate,'boolean','publicationCandidate must be an explicit boolean')
  if(!publicationCandidate)return {private:true}
  assert.equal(sourceBinding?.status,'verified','Publication-format candidates require verified source binding')
  const pkg=json(join(staging,'package.json'))
  assert.ok(isAlphaSDKVersion(pkg.version),'Publication-format candidates require an explicit alpha version in staging')
  assert.equal(pkg.license,'MIT','Publication-format candidates require MIT metadata in staging')
  assert.equal(pkg.repository?.type,'git','Publication-format candidates require a git repository in staging')
  assert.ok(typeof pkg.repository.url==='string','Publication-format candidates require a repository URL in staging')
  const url=new URL(pkg.repository.url)
  assert.ok(url.protocol==='https:'&&!url.username&&!url.password,'Publication-format repository must be HTTPS without credentials')
  for(const directory of [staging,projectRoot]){
    const stat=lstatSync(join(directory,'LICENSE'))
    assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Publication-format LICENSE must be a regular file')
  }
  assert.deepEqual(readFileSync(join(staging,'LICENSE')),readFileSync(join(projectRoot,'LICENSE')),'Staging LICENSE differs from verified source LICENSE')
  return {private:false,publishConfig:{access:'public'}}
}

/** Split an already verified build. The original build is never changed. */
export async function buildSDKPackages(staging,{sourceArchive=process.env.SDK_SOURCE_ARCHIVE,publicationCandidate=false}={}){
  staging=resolve(staging)
  verifySDK(staging)
  const original=json(join(staging,'package.json')),contract=json(join(staging,'api-contract.json'))
  if(contract.apiVersion<6)throw Error('Split assets API requires SDK apiVersion 6 or later. Rebuild staging from source; do not reuse older SDK bundles.')
  if(typeof original.version!=='string'||!original.version)throw Error('Staging package needs an exact version')
  const sourceBinding=verifySDKPackageSources(staging,{sourceArchive})
  const packageFormat=resolveSDKPackageFormat(staging,{publicationCandidate,sourceBinding})
  const output=mkdtempSync(join(tmpdir(),'browser-sandbox-packages-'))
  const core=join(output,'sdk'),runtime=join(output,'runtime')
  mkdirSync(core);mkdirSync(runtime)
  // Evidence is deliberately outside both publishable package directories.
  copy(staging,join(output,'build-evidence','staging'))
  const omitted=new Set(['manifest.json','package.json','api-contract.json','assets.mjs','examples','size-report.json','candidate-compatibility.json','release-record.json','verify-sdk.mjs','check-sdk-release.mjs','sdk-build-profiles.mjs','sdk-license-policy.mjs'])
  for(const name of readdirSync(staging)){
    if(omitted.has(name))continue
    if(name==='runtime')continue
    const runtimeOwned=['preview-host','kernel-host.js','kernel-host.html','licenses'].includes(name)
    copy(join(staging,name),join(runtimeOwned?runtime:core,name))
    if(name==='licenses')copy(join(staging,name),join(core,name))
    if(name==='LICENSE')copy(join(staging,name),join(runtime,name))
  }
  for(const name of readdirSync(join(staging,'runtime'))){
    if(name==='rolldown-parser')continue
    if(name==='compiler'){
      for(const item of readdirSync(join(staging,'runtime/compiler')))if(item!=='esbuild.wasm')copy(join(staging,'runtime/compiler',item),join(runtime,'runtime/compiler',item))
    }else copy(join(staging,'runtime',name),join(runtime,'runtime',name))
  }
  copy(join(sourceRoot,'src/sdk/package-assets.mjs'),join(core,'assets.mjs'))
  writeFileSync(join(core,'README.md'),readFileSync(join(sourceRoot,'src/sdk/PACKAGES.md')))
  // These hosts require split packages, so they belong here, not in staging.
  for(const [name,files] of Object.entries({
    basic:['README.md','package.json','index.html','client.js','server.mjs','host.mjs'],
    frameworks:['README.md','package.json','index.html','client.js','scripts.mjs','ports.mjs','server.mjs','host.mjs','projects.json'],
  }))for(const file of files)copy(join(sourceRoot,'examples','sdk-'+name,file),join(core,'examples',name,file))
  const declarations={entry:contract.entrypoints['.'].types,assetsEntry:contract.entrypoints['./assets'].types,files:contract.declarations.map(file=>file.path)}
  writeFileSync(join(core,declarations.assetsEntry),readFileSync(join(sourceRoot,'src/sdk/package-assets.d.ts')))
  const apiContract=buildSDKAPIContract(core,declarations,{requireCompatibility:true})
  const runtimeName='@tanstack/browser-sandbox-runtime-experimental'
  const corePackage={...original,name:'@tanstack/browser-sandbox-experimental',dependencies:{...original.dependencies,[runtimeName]:original.version},sdkCompatibility:{...original.sdkCompatibility,apiVersion:apiContract.apiVersion,stability:apiContract.stability,contract:apiContract.path,sha256:apiContract.sha256},exports:{...original.exports}}
  delete corePackage.exports['./check-release']
  delete corePackage.sdkDistribution
  delete corePackage.publishConfig
  Object.assign(corePackage,packageFormat)
  writeJSON(join(core,'package.json'),corePackage)
  copy(join(sourceRoot,'src/sdk/runtime-package-setup.mjs'),join(runtime,'setup.mjs'))
  copy(join(sourceRoot,'src/sdk/compiler-assets.mjs'),join(runtime,'compiler-assets.mjs'))
  const compilerArtifact=json(join(staging,'runtime/compiler/artifact.json'))
  const stagingManifest=json(join(staging,'manifest.json'))
  const config={compilerArtifact}
  const profile={buildProfile:stagingManifest.buildProfile,engines:stagingManifest.engines,experimentalCompiler:stagingManifest.experimentalCompiler}
  if(stagingManifest.experimentalRolldownParser){
    const {assets,...parser}=stagingManifest.experimentalRolldownParser
    profile.experimentalRolldownParser=parser
  }
  writeJSON(join(runtime,'runtime-profile.json'),profile)
  if(stagingManifest.experimentalRolldownParser){
    config.parserInputs=json(join(sourceRoot,'src/compiler/rolldown-parser-inputs.json'))
    config.parserPolicy=json(join(staging,'runtime/rolldown-parser/artifact.json'))
    await buildRolldownAdapter(join(runtime,'adapter'))
  }
  writeJSON(join(runtime,'compiler-config.json'),config)
  const runtimePackage={name:runtimeName,version:original.version,type:'module',description:'Runtime assets and deployment setup for the TanStack browser sandbox.',dependencies:{...requiredDependencies},exports:{'./setup':{node:'./setup.mjs'}}}
  for(const key of ['license','private','publishConfig','repository','homepage','bugs'])if(original[key]!==undefined)runtimePackage[key]=original[key]
  delete runtimePackage.publishConfig
  Object.assign(runtimePackage,packageFormat)
  writeJSON(join(runtime,'package.json'),runtimePackage)
  // Adapter bundling is asynchronous. Refuse a source tree edited after the
  // initial check instead of marking a mixed-source package verified.
  if(sourceBinding.status==='verified')assert.deepEqual(verifySDKPackageSources(staging,{sourceArchive}),sourceBinding,'Source changed during split packaging')
  manifest(core);manifest(runtime)
  verifyCompilerPackageBoundary(core,runtime)
  writeJSON(join(output,'candidate-status.json'),{format:1,packageFormat:publicationCandidate?'publication-candidate':'private-candidate',releaseApproved:false,packagingOnly:true,browserAcceptance:false,exampleAcceptance:false,sourceManifestSHA256:hash(readFileSync(join(staging,'manifest.json'))),sourceBinding})
  return {output,core,runtime,evidence:join(output,'build-evidence','staging')}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),publicationCandidate=args[0]==='--publication-candidate'
  if(publicationCandidate)args.shift()
  if(args.length!==1||args[0].startsWith('--'))throw Error('Usage: node scripts/build-sdk-packages.mjs [--publication-candidate] VERIFIED_STAGING_DIRECTORY')
  console.log(JSON.stringify(await buildSDKPackages(args[0],{publicationCandidate}),null,2))
}
