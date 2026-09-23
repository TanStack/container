import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync,readdirSync,lstatSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join,resolve,dirname,sep,basename} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {verifyDeploymentAssets} from './sdk-external-assets.mjs'
import {build} from 'vite'
import ts from 'typescript'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
export function installedPackageInventory(directory){
  const entries=[]
  function visit(prefix=''){
    for(const name of readdirSync(join(directory,prefix)).sort()){
      // npm may own a nested dependency tree. It is not part of this package.
      if(!prefix&&name==='node_modules')continue
      const path=prefix?prefix+'/'+name:name,stat=lstatSync(join(directory,path))
      assert.ok(!stat.isSymbolicLink(),'Installed package contains a symlink: '+path)
      if(stat.isDirectory())visit(path)
      else {assert.ok(stat.isFile());const bytes=readFileSync(join(directory,path));entries.push({path,bytes:bytes.length,sha256:hash(bytes)})}
    }
  }
  visit()
  const manifest=JSON.parse(readFileSync(join(directory,'package-assets.json'),'utf8'))
  assert.equal(manifest.format,1)
  assert.deepEqual(entries.filter(item=>item.path!=='package-assets.json').sort((a,b)=>a.path.localeCompare(b.path)),[...manifest.files].sort((a,b)=>a.path.localeCompare(b.path)),'Installed package inventory differs from its manifest')
  return entries
}

export function verifyConsumerTypes(consumer){
  consumer=realpathSync(consumer)
  const checked=[]
  for(const [name,module,moduleResolution] of [['bundler',ts.ModuleKind.ESNext,ts.ModuleResolutionKind.Bundler],['nodenext',ts.ModuleKind.NodeNext,ts.ModuleResolutionKind.NodeNext]]){
    const program=ts.createProgram([join(consumer,'types-check.ts')],{target:ts.ScriptTarget.ES2022,module,moduleResolution,strict:true,noEmit:true,skipLibCheck:false,types:[],lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts']})
    const diagnostics=ts.getPreEmitDiagnostics(program)
    assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:file=>file,getCurrentDirectory:()=>consumer,getNewLine:()=> '\n'}))
    const installed=join(consumer,'node_modules')+sep
    const sdkSources=program.getSourceFiles().filter(source=>source.fileName.includes('@tanstack/browser-sandbox-experimental/'))
    assert.ok(sdkSources.length,'Typecheck did not resolve the installed SDK')
    for(const source of sdkSources)assert.ok(source.fileName.startsWith(installed),'Typecheck escaped consumer installation')
    checked.push(name)
  }
  return checked
}

export async function testSDKPackages(input){

const source=resolve(input)
const workspace=realpathSync(mkdtempSync(join(tmpdir(),'sdk-split-consumer-')))
function npm(args,cwd=workspace){
  const result=spawnSync('npm',args,{cwd,encoding:'utf8',env:{...process.env,npm_config_cache:join(workspace,'npm-cache'),npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'}})
  if(result.status!==0)throw Error(result.stdout+result.stderr)
  return result.stdout
}
const tarballs=[]
const packageEvidence=[]
for(const name of ['sdk','runtime']){
  const packs=[]
  for(const round of ['first','second']){
    const destination=join(workspace,name+'-'+round);mkdirSync(destination)
    const records=JSON.parse(npm(['pack',join(source,name),'--json','--ignore-scripts','--pack-destination',destination]))
    assert.equal(records.length,1);const packed=records[0]
    assert.ok(typeof packed.filename==='string'&&basename(packed.filename)===packed.filename)
    const tarball=join(destination,packed.filename)
    packs.push({packed,tarball,sha256:hash(readFileSync(tarball))})
  }
  assert.equal(packs[0].sha256,packs[1].sha256,name+' tarball is not reproducible')
  assert.deepEqual(packs[0].packed.files,packs[1].packed.files,name+' pack inventory is not reproducible')
  const {packed,tarball,sha256}=packs[0]
  if(name==='sdk')assert.ok(packed.files.every(file=>!file.path.endsWith('.wasm')&&!file.path.startsWith('runtime/')))
  else assert.ok(packed.files.every(file=>!file.path.endsWith('parser.wasm')&&!file.path.endsWith('esbuild.wasm')&&!file.path.endsWith('pthread.js')))
  tarballs.push(tarball)
  packageEvidence.push({role:name,name:packed.name,tarball,sha256,reproducible:true})
}
const consumer=join(workspace,'consumer');mkdirSync(consumer)
writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'sdk-split-test',version:'1.0.0',private:true,type:'module'}))
npm(['install','--ignore-scripts','--no-audit','--no-fund',...tarballs],consumer)
const installedDirectories=['@tanstack/browser-sandbox-experimental','@tanstack/browser-sandbox-runtime-experimental'].map(name=>join(consumer,'node_modules',name))
const inventories=installedDirectories.map(installedPackageInventory)
const require=createRequire(join(consumer,'package.json'))
const assets=await import(pathToFileURL(require.resolve('@tanstack/browser-sandbox-experimental/assets')))
const output=await assets.prepareRuntimeAssets(join(consumer,'hosted'))
const manifest=JSON.parse(readFileSync(output.manifestPath,'utf8'))
verifyDeploymentAssets(output.directory,manifest,{packageManifestSHA256:manifest.packageManifestSHA256,expectedFiles:manifest.files})
for(const path of ['runtime/workers/kernel.js','runtime/compiler/esbuild.wasm','kernel-host.html','preview-host/hosting.json'])assert.ok(existsSync(join(output.directory,path)),path)
await assert.rejects(assets.prepareRuntimeAssets(output.directory))
const installedSDK=dirname(require.resolve('@tanstack/browser-sandbox-experimental/assets'))
const packageJSON=JSON.parse(readFileSync(join(installedSDK,'package.json'),'utf8'))
const sdk=await import(pathToFileURL(join(installedSDK,packageJSON.exports['.'].import)))
assert.equal(typeof sdk.WorkerKernel,'function')
writeFileSync(join(consumer,'types-check.ts'),`import {WorkerKernel, HostedKernel, AgentSession, SDK_COMPATIBILITY, resolveSDKRuntimeProfile} from '@tanstack/browser-sandbox-experimental';
import {prepareRuntimeAssets, readRuntimeProfileManifest, readPreviewHostHostingContract} from '@tanstack/browser-sandbox-experimental/assets';
async function setup(){
 const assets = await prepareRuntimeAssets('/absolute/new/assets');
 const directory: string = assets.runtimeDirectory;
 const profile = resolveSDKRuntimeProfile(readRuntimeProfileManifest(), 'tanstack-start');
 const kernel = new WorkerKernel({}, {assetBaseURL:'https://example.test/runtime/', ...profile.kernelOptions});
 const bytes: Uint8Array = await kernel.readFile('/file');
 const snapshot = await kernel.snapshot();
 const session = new AgentSession({}, {kernel});
 const binarySnapshot = await session.snapshot({encoding:'binary'});
 await kernel.restore(snapshot); kernel.close(); await kernel.shutdown;
 return {directory, bytes, binarySnapshot, contract:readPreviewHostHostingContract(), api:SDK_COMPATIBILITY.apiVersion, hosted:HostedKernel};
}
void setup;
`)
const typeResolution=verifyConsumerTypes(consumer)
writeFileSync(join(consumer,'index.html'),'<script type="module" src="/main.js"></script>')
writeFileSync(join(consumer,'main.js'),'import {WorkerKernel} from "@tanstack/browser-sandbox-experimental"; globalThis.createSandbox = () => new WorkerKernel({}, {assetBaseURL:new URL("/sandbox/runtime/",location.origin).href});')
await build({root:consumer,configFile:false,publicDir:false,logLevel:'error',build:{outDir:join(consumer,'dist'),emptyOutDir:false}})
npm(['uninstall','--offline','--ignore-scripts','--no-audit','--no-fund',...packageEvidence.map(item=>item.name)],consumer)
for(const directory of installedDirectories)assert.ok(!existsSync(directory),'Uninstall retained '+directory)
npm(['install','--offline','--ignore-scripts','--no-audit','--no-fund',...tarballs],consumer)
assert.deepEqual(installedDirectories.map(installedPackageInventory),inventories,'Reinstall changed package contents')
assert.deepEqual(verifyConsumerTypes(consumer),typeResolution)
const prepareAgain=spawnSync(process.execPath,['--input-type=module','-e',`import {prepareRuntimeAssets} from '@tanstack/browser-sandbox-experimental/assets'; console.log(JSON.stringify(await prepareRuntimeAssets(${JSON.stringify(join(consumer,'hosted-reinstalled'))})));`],{cwd:consumer,encoding:'utf8'})
assert.equal(prepareAgain.status,0,prepareAgain.stderr)
const reinstalledOutput=JSON.parse(prepareAgain.stdout),reinstalledManifest=JSON.parse(readFileSync(reinstalledOutput.manifestPath,'utf8'))
verifyDeploymentAssets(reinstalledOutput.directory,reinstalledManifest,{packageManifestSHA256:manifest.packageManifestSHA256,expectedFiles:manifest.files})
assert.deepEqual(reinstalledManifest,manifest,'Reinstall changed prepared deployment')
return {workspace,consumer,output,files:manifest.files.length,packages:packageEvidence,typeResolution,reinstall:true,reinstalledDeploymentMatches:true,passed:true}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(!process.argv[2])throw Error('Usage: node scripts/test-sdk-packages.mjs PACKAGE_BUILD_DIRECTORY')
  console.log(JSON.stringify(await testSDKPackages(process.argv[2]),null,2))
}
