import {build} from 'vite'
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,readdirSync,readFileSync,lstatSync} from 'node:fs'
import {join,resolve,relative,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {buildSDKTypes} from './build-sdk-types.mjs'
import {verifySDK,inspectSDKFSCopy} from './verify-sdk.mjs'
import {inspectSDKBuildProfile, inspectSDKEngine} from './sdk-build-profiles.mjs'
import {sdkInputRecorder,writeSDKNotices} from './sdk-notices.mjs'
import {buildSDKAPIContract} from './sdk-api-contract.mjs'
import {writeSDKSizeReport} from './sdk-size-report.mjs'
import {writeSDKCompatibilityPolicy} from './sdk-compatibility-policy.mjs'
import {buildRolldownParser} from './build-rolldown-parser.mjs'
import {SDK_CANDIDATE_COMPATIBILITY_PATH,SDK_RELEASE_RECORD_PATH,writeSDKReleaseRecords} from './sdk-release-record.mjs'
import {resolveSDKPackageMetadata} from './sdk-package-metadata.mjs'
import {verifySourceSnapshot} from './source-snapshot.mjs'

// Selection is explicit and separate from the lab server's candidate flags.
const buildProfile=process.env.SDK_BUILD_PROFILE??'default'
const packageMetadata=resolveSDKPackageMetadata()
if(packageMetadata.release){
  if(!process.env.SDK_SOURCE_ARCHIVE)throw Error('Public SDK release builds require SDK_SOURCE_ARCHIVE from scripts/source-snapshot.mjs')
  verifySourceSnapshot(process.cwd(),process.env.SDK_SOURCE_ARCHIVE)
}
const engines=inspectSDKBuildProfile(resolve('public'),buildProfile)
const compilerArtifact=JSON.parse(readFileSync('src/compiler/esbuild-artifact.json','utf8'))
for(const [name,expected] of Object.entries(compilerArtifact.hashes)){
  const bytes=readFileSync(resolve('node_modules/esbuild-wasm',name))
  if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Unsupported host compiler artifact: '+name)
}
const sdkEsbuildWasm='\0sdk-esbuild-wasm-url'
const packagedWorkerFactories={name:'packaged-worker-factories',enforce:'pre',resolveId(source,importer){
  if(source==='esbuild-wasm/esbuild.wasm?url')return sdkEsbuildWasm
  if(importer&&resolve(dirname(importer),source).replace(/\.ts$/,'')===resolve('src/sandbox/worker-factories'))return resolve('src/sdk/worker-factories.ts')
},load(id){if(id===sdkEsbuildWasm)return `export default new URL(/* @vite-ignore */'../compiler/esbuild.wasm',import.meta.url).href`}}

// A fresh output directory avoids stale chunks and never clears user files.
const out=mkdtempSync(join(tmpdir(),'browser-sandbox-sdk-'))
const runtime=join(out,'runtime');mkdirSync(runtime)
const projectRoot=resolve('.')
function removeRepositoryPath(path){
  const text=readFileSync(path,'utf8')
  if(text.includes(projectRoot))writeFileSync(path,text.split(projectRoot).join('<repository>'))
}
function removeRepositoryPaths(directory){
  for(const entry of readdirSync(directory)){
    const path=join(directory,entry),stat=lstatSync(path)
    if(stat.isDirectory())removeRepositoryPaths(path)
    else if(stat.isFile()&&(entry.endsWith('.mjs')||entry.endsWith('.js')||entry.endsWith('.json')))removeRepositoryPath(path)
  }
}
const recorded=sdkInputRecorder()
const parserRoot=process.env.SDK_ROLLDOWN_PARSER_ROOT
const parserArtifact=parserRoot?await buildRolldownParser(resolve(parserRoot),join(runtime,'rolldown-parser')):undefined
if(parserArtifact)for(const source of Object.keys(parserArtifact.sources))recorded.inputs.add(source.startsWith('npm/')?resolve(parserRoot,'node_modules',source.slice(4)):resolve(source.slice('workspace/'.length)))
mkdirSync(join(runtime,'compiler'))
cpSync(resolve('node_modules/esbuild-wasm/esbuild.wasm'),join(runtime,'compiler/esbuild.wasm'),{errorOnExist:true,force:false})
cpSync(resolve('public/mvdan-shell/GO-LICENSE'),join(runtime,'compiler/GO-LICENSE'),{errorOnExist:true,force:false})
writeFileSync(join(runtime,'compiler/artifact.json'),JSON.stringify(compilerArtifact,null,2)+'\n')
await build({configFile:false,root:process.cwd(),publicDir:false,base:'./',worker:{format:'es'},plugins:[packagedWorkerFactories,recorded.plugin],
  build:{outDir:join(runtime,'workers'),emptyOutDir:false,target:'es2022',lib:{entry:{
    kernel:resolve('src/sandbox/kernel.worker.ts'),compiler:resolve('src/sandbox/compiler.worker.ts'),'mvdan-shell':resolve('src/sandbox/mvdan-shell.worker.ts'),
    'browser-compiler':resolve('src/compiler/browser-compiler-bundled.worker.ts'),
  },formats:['es'],fileName:(_format,name)=>name+'.js'}}})
await build({configFile:false,root:process.cwd(),publicDir:false,base:'./',worker:{format:'es'},
  plugins:[packagedWorkerFactories,recorded.plugin],
  build:{outDir:out,emptyOutDir:false,target:'es2022',lib:{entry:resolve('src/sdk/index.ts'),formats:['es'],fileName:()=> 'index.js'}}})
await build({configFile:false,root:process.cwd(),publicDir:false,base:'./',worker:{format:'es'},
  plugins:[packagedWorkerFactories,recorded.plugin],
  build:{outDir:out,emptyOutDir:false,target:'es2022',lib:{entry:resolve('src/sdk/kernel-host.ts'),formats:['es'],fileName:()=> 'kernel-host.js'}}})
cpSync(resolve('src/sdk/kernel-host.html'),join(out,'kernel-host.html'),{errorOnExist:true,force:false})
for(const [slot,engine] of Object.entries(engines)){
  cpSync(resolve('public',engine.sourceDirectory),join(runtime,slot),{recursive:true,errorOnExist:true,force:false})
  removeRepositoryPaths(join(runtime,slot))
  const copied=inspectSDKEngine(join(runtime,slot),slot,buildProfile)
  if(copied.wasmSHA256!==engine.wasmSHA256||copied.metadataSHA256!==engine.metadataSHA256)throw Error('SDK engine changed during packaging: '+slot)
}
const directories=['kernel-runtime','vm-web-apis','tls-runtime','http2-runtime','mvdan-shell']
for(const directory of directories){
  cpSync(resolve('public',directory),join(runtime,directory),{recursive:true,errorOnExist:true,force:false})
  const metadata=join(runtime,directory,'build.json')
  if(lstatSync(metadata).isFile())removeRepositoryPath(metadata)
}
const shellBuild=JSON.parse(readFileSync(resolve('public/mvdan-shell/build.json'),'utf8'))
const preview=join(out,'preview-host','__sandbox');mkdirSync(preview,{recursive:true})
for(const name of ['bridge.html','bridge.js','sw.js','inspect.js','websocket.js'])cpSync(resolve('preview-host',name),join(preview,name),{errorOnExist:true,force:false})
const requestPolicy=JSON.parse(readFileSync('src/sandbox/request-policy.json','utf8'))
writeFileSync(join(preview,'request-policy.js'),`self.SANDBOX_REQUEST_TIMEOUT_MS=${JSON.stringify(requestPolicy.maxRequestTimeoutMs)};\n`)
writeFileSync(join(out,'preview-host','hosting.json'),JSON.stringify({
  separateOrigin:true,secureContext:true,scope:'/',fallbackStatus:503,
  embedderPolicy:'require-corp',
  documentResourcePolicy:'cross-origin',
  fallbackHeaders:{'Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'cross-origin'},
  routes:['bridge.html','bridge.js','sw.js','inspect.js','websocket.js','request-policy.js'].map(name=>({
    path:'/__sandbox/'+name,file:'__sandbox/'+name,method:'GET',headers:{
      'Content-Type':name.endsWith('.html')?'text/html':'text/javascript',
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Service-Worker-Allowed':'/',
      'Cross-Origin-Embedder-Policy':'require-corp',
      ...(name.endsWith('.html')?{'Cross-Origin-Resource-Policy':'cross-origin','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"}:{}),
    },
  })),
},null,2)+'\n')
const declarations=buildSDKTypes(out)
// Legacy copy helpers describe this internal staging tree, not the public SDK.
// The split builder emits the public assets declarations and contract.
const apiContract=buildSDKAPIContract(out,declarations,{requireCompatibility:true,internalStaging:true})
const compatibilityPolicy=writeSDKCompatibilityPolicy(out)
writeFileSync(join(out,'README.md'),'# Internal SDK staging\n\nThis private build is input to scripts/build-sdk-packages.mjs, not an installable public SDK release. Its legacy copy helpers describe the staging tree only. The split builder writes the public assets API, API contract and installation guide. The shared browser and kernel-host API version comes from source; never patch these generated bundles to change it.\n')
cpSync(resolve('src/sdk/COMPATIBILITY.md'),join(out,'COMPATIBILITY.md'),{errorOnExist:true,force:false})
if(packageMetadata.licensePath)cpSync(packageMetadata.licensePath,join(out,'LICENSE'),{errorOnExist:true,force:false})
const licenseCoverage=writeSDKNotices(out,process.cwd(),recorded.inputs,engines,parserRoot?resolve(parserRoot):undefined,packageMetadata.licensePath?{path:packageMetadata.licensePath,spdx:packageMetadata.packageFields.license}:undefined)
cpSync(resolve('src/sdk/assets.mjs'),join(out,'assets.mjs'),{errorOnExist:true,force:false})
cpSync(resolve('scripts/verify-sdk.mjs'),join(out,'verify-sdk.mjs'),{errorOnExist:true,force:false})
cpSync(resolve('scripts/sdk-build-profiles.mjs'),join(out,'sdk-build-profiles.mjs'),{errorOnExist:true,force:false})
cpSync(resolve('scripts/sdk-license-policy.mjs'),join(out,'sdk-license-policy.mjs'),{errorOnExist:true,force:false})
cpSync(resolve('scripts/sdk-api-compare.mjs'),join(out,'sdk-api-compare.mjs'),{errorOnExist:true,force:false})
cpSync(resolve('scripts/check-sdk-release.mjs'),join(out,'check-sdk-release.mjs'),{errorOnExist:true,force:false})
const sizeReport=writeSDKSizeReport(out,process.cwd(),recorded.inputs)
// Release metadata supplies the eventual version/license, never permission to
// publish the intermediate all-in-one staging tree.
packageMetadata.packageFields.private=true
packageMetadata.packageFields.sdkDistribution='internal-staging'
delete packageMetadata.packageFields.publishConfig
writeFileSync(join(out,'package.json'),JSON.stringify({name:'@tanstack/browser-sandbox-experimental',...packageMetadata.packageFields,type:'module',types:declarations.entry,sdkCompatibility:{apiVersion:apiContract.apiVersion,stability:apiContract.stability,contract:apiContract.path,sha256:apiContract.sha256,policy:compatibilityPolicy.path},exports:{'.':{types:declarations.entry,import:'./index.js'},'./assets':{types:declarations.assetsEntry,node:'./assets.mjs'},'./api-contract':'./'+apiContract.path,'./compatibility-policy':'./'+compatibilityPolicy.path,'./compare-api':{node:'./sdk-api-compare.mjs'},'./check-release':{node:'./check-sdk-release.mjs'}}},null,2)+'\n')
const files=[]
function visit(directory){for(const entry of readdirSync(directory).sort()){
  const path=join(directory,entry),stat=lstatSync(path)
  if(stat.isSymbolicLink())throw Error('Unexpected SDK symlink: '+path)
  if(stat.isDirectory())visit(path)
  else if(stat.isFile()){const bytes=readFileSync(path);files.push({path:relative(out,path),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})}
  else throw Error('Unsupported SDK artifact: '+path)
}}
visit(out)
writeFileSync(join(out,'manifest.json'),JSON.stringify({experimental:true,apiContract,compatibilityPolicy,buildProfile,engines,licenseCoverage,sizeReport,attestations:{candidateCompatibility:SDK_CANDIDATE_COMPATIBILITY_PATH,releaseRecord:SDK_RELEASE_RECORD_PATH},...(packageMetadata.licensePath?{projectLicense:{path:'LICENSE',spdx:packageMetadata.packageFields.license,sha256:createHash('sha256').update(readFileSync(join(out,'LICENSE'))).digest('hex')}}:{}),...(parserArtifact?{experimentalRolldownParser:{enabledByDefault:false,directory:'runtime/rolldown-parser',artifact:'runtime/rolldown-parser/artifact.json',version:parserArtifact.version,resources:parserArtifact.resources,assets:parserArtifact.assets}}:{}),experimentalCompiler:{enabledByDefault:false,worker:'runtime/workers/browser-compiler.js',artifact:'runtime/compiler/artifact.json',version:compilerArtifact.version,runtimeSHA256:compilerArtifact.hashes['wasm_exec.js']},fsCopy:inspectSDKFSCopy(out),shell:{
  api:'one-shot',implementation:'mvdan.cc/sh/v3',version:shellBuild.mvdan,
  statePersistence:false,terminal:false,numericFdRedirection:'unsupported',externalCommands:'kernel-processes',
  wasmSHA256:shellBuild.wasmSHA256,sourceSHA256:shellBuild.sourceSHA256,lockSHA256:shellBuild.lockSHA256,
  goBuild:shellBuild.goBuild,
  evidence:{isolatedAdapter:{passed:18,total:19,browsers:['chromium','firefox','webkit']},integratedKernel:{passed:21,total:21,browsers:['chromium','firefox','webkit']}},
},files},null,2)+'\n')
writeSDKReleaseRecords(out,{evidencePath:process.env.SDK_COMPATIBILITY_EVIDENCE,sourceArchive:process.env.SDK_SOURCE_ARCHIVE})
verifySDK(out)
console.log('SDK_OUTPUT='+out)
