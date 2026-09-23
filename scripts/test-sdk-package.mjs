import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {basename,dirname,join,relative,resolve,sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import {
  cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,
  realpathSync,writeFileSync,
} from 'node:fs'
import ts from 'typescript'
import {build} from 'vite'
import {verifySDK} from './verify-sdk.mjs'

const projectRoot=realpathSync(new URL('../',import.meta.url).pathname)
const supplied=process.argv[2]
if(!supplied)throw Error('Usage: node scripts/test-sdk-package.mjs SDK_DIRECTORY')
const sdk=realpathSync(resolve(supplied))
verifySDK(sdk)

const workspace=realpathSync(mkdtempSync(join(tmpdir(),'browser-sandbox-package-acceptance-')))
const packs=[join(workspace,'pack-a'),join(workspace,'pack-b')]
for(const directory of packs)mkdirSync(directory)

function npm(arguments_,cwd){
  const result=spawnSync('npm',arguments_,{
    cwd,encoding:'utf8',env:{...process.env,npm_config_cache:join(workspace,'npm-cache'),npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'},
  })
  if(result.status!==0)throw Error(`npm ${arguments_.join(' ')} failed\n${result.stdout}${result.stderr}`)
  return result.stdout
}

function pack(destination){
  const records=JSON.parse(npm(['pack',sdk,'--json','--pack-destination',destination,'--ignore-scripts'],workspace))
  if(records.length!==1||!records[0].filename)throw Error('npm pack did not produce exactly one tarball')
  const tarball=join(destination,records[0].filename)
  if(!existsSync(tarball)||!lstatSync(tarball).isFile())throw Error('npm pack output is missing')
  return {tarball,record:records[0],sha256:createHash('sha256').update(readFileSync(tarball)).digest('hex')}
}

const first=pack(packs[0]),second=pack(packs[1])
if(first.sha256!==second.sha256)throw Error('npm package tarball is not reproducible')
if(JSON.stringify(first.record.files)!==JSON.stringify(second.record.files))throw Error('npm package file list is not reproducible')

const consumer=join(workspace,'consumer')
mkdirSync(consumer)
writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'sdk-package-consumer',private:true,type:'module'},null,2)+'\n')
npm(['install','--offline','--ignore-scripts','--no-audit','--no-fund','--no-package-lock',first.tarball],consumer)

const installed=realpathSync(join(consumer,'node_modules/@tanstack/browser-sandbox-experimental'))
if(installed.startsWith(sdk+sep))throw Error('npm installed a link to the SDK build instead of the tarball')
const summary=verifySDK(installed)
const packageJSON=JSON.parse(readFileSync(join(installed,'package.json'),'utf8'))
const manifest=JSON.parse(readFileSync(join(installed,'manifest.json'),'utf8'))

function files(root,relativeDirectory=''){
  const found=[]
  for(const name of readdirSync(join(root,relativeDirectory)).sort()){
    const path=relativeDirectory?relativeDirectory+'/'+name:name
    const stat=lstatSync(join(root,path))
    if(stat.isSymbolicLink())throw Error('Installed package contains a symlink: '+path)
    if(stat.isDirectory())found.push(...files(root,path))
    else if(stat.isFile())found.push(path)
    else throw Error('Installed package contains an unsupported entry: '+path)
  }
  return found
}

const declared=[...manifest.files.map(file=>file.path),'manifest.json',...Object.values(manifest.attestations??{})].sort()
const installedFiles=files(installed).sort()
if(JSON.stringify(installedFiles)!==JSON.stringify(declared))throw Error('npm package contains undeclared or missing files')
const packedFiles=first.record.files.map(file=>file.path).sort()
if(JSON.stringify(packedFiles)!==JSON.stringify(declared))throw Error('npm pack file list differs from the SDK manifest')

const forbidden=[projectRoot,sdk,'file://'+projectRoot,'file://'+sdk]
for(const path of installedFiles){
  const bytes=readFileSync(join(installed,path))
  for(const value of forbidden)if(bytes.includes(Buffer.from(value)))throw Error(`Repository or build path leaked into ${path}`)
}

const require=createRequire(join(consumer,'package.json'))
const entry=await import(pathToFileURL(join(installed,packageJSON.exports['.'].import)).href)
const contract=JSON.parse(readFileSync(require.resolve(packageJSON.name+'/api-contract'),'utf8'))
const expectedExports=contract.entrypoints['.'].exports.filter(item=>(item.flags&ts.SymbolFlags.Value)!==0).map(item=>item.name)
if(JSON.stringify(Object.keys(entry).sort())!==JSON.stringify([...expectedExports].sort()))throw Error('Runtime exports differ from the API contract')
if(JSON.stringify(entry.SDK_COMPATIBILITY)!==JSON.stringify({apiVersion:contract.apiVersion,stability:contract.stability}))throw Error('Installed compatibility export differs from the API contract')
const agentCancellation=spawnSync(process.execPath,['--test',join(projectRoot,'tests/sdk-agent-acquisition.test.mjs')],{
  cwd:consumer,encoding:'utf8',env:{...process.env,SDK_OUTPUT:installed},timeout:15000,
})
if(agentCancellation.status!==0)throw Error(`Installed agent acquisition cancellation failed\n${agentCancellation.stdout}${agentCancellation.stderr}`)
if(packageJSON.sdkCompatibility.sha256!==manifest.apiContract.sha256)throw Error('Installed package API contract hash differs from its manifest')
const compatibilityPolicy=JSON.parse(readFileSync(require.resolve(packageJSON.name+'/compatibility-policy'),'utf8'))
if(compatibilityPolicy.stability!=='experimental'||packageJSON.sdkCompatibility.policy!=='compatibility-policy.json'||manifest.compatibilityPolicy.path!=='compatibility-policy.json')throw Error('Installed compatibility policy differs from the package contract')

const workers=[]
const OriginalWorker=globalThis.Worker
const originalLocation=globalThis.location
class ConstructionWorker {
  constructor(url,options){this.url=String(url);this.options=options;workers.push(this)}
  postMessage(message){queueMicrotask(()=>this.onmessage?.({data:{id:message.id,type:'result',value:{}}}))}
  terminate(){this.terminated=true}
}
globalThis.Worker=ConstructionWorker
globalThis.location={href:'https://consumer.invalid/app/index.html'}
try{
  const hostedBase='https://consumer.invalid/sdk-runtime/'
  const hostedKernel=new entry.WorkerKernel({}, {assetBaseURL:hostedBase})
  await hostedKernel.resources()
  if(hostedKernel.assetBaseURL!==hostedBase)throw Error('Explicit SDK asset URL changed during construction')
  const http=new entry.WorkerHTTP(hostedKernel,4173)
  if(http.kernel!==hostedKernel||http.port!==4173)throw Error('Public WorkerHTTP construction failed')
  hostedKernel.close()
  const expectedWorkers=[
    {url:new URL('workers/kernel.js',hostedBase).href,options:{type:'module'}},
  ]
  const actualWorkers=workers.map(worker=>({url:worker.url,options:worker.options}))
  if(JSON.stringify(actualWorkers)!==JSON.stringify(expectedWorkers)||workers.some(worker=>worker.terminated!==true))throw Error('Public kernel did not construct and close packaged module workers')
}finally{
  if(OriginalWorker===undefined)delete globalThis.Worker
  else globalThis.Worker=OriginalWorker
  if(originalLocation===undefined)delete globalThis.location
  else globalThis.location=originalLocation
}
const compare=await import(pathToFileURL(require.resolve(packageJSON.name+'/compare-api')).href)
if(compare.compareSDKAPIContracts(contract,contract).compatible!==true)throw Error('Installed API comparison entry failed its identity check')

const assets=await import(pathToFileURL(require.resolve(packageJSON.name+'/assets')).href)
const publicRuntime=join(consumer,'public','runtime')
mkdirSync(dirname(publicRuntime),{recursive:true})
assets.copyRuntimeAssets(publicRuntime)
const sourceRuntime=files(join(installed,'runtime'))
const copiedRuntime=files(publicRuntime)
if(JSON.stringify(copiedRuntime)!==JSON.stringify(sourceRuntime))throw Error('Runtime asset helper did not copy the complete runtime')
for(const path of sourceRuntime){
  const sourceHash=createHash('sha256').update(readFileSync(join(installed,'runtime',path))).digest('hex')
  const copyHash=createHash('sha256').update(readFileSync(join(publicRuntime,path))).digest('hex')
  if(sourceHash!==copyHash)throw Error('Copied runtime asset changed: '+path)
}
const publicPreviewHost=join(consumer,'public','preview-host')
assets.copyPreviewHostAssets(publicPreviewHost)
const sourcePreviewHost=files(join(installed,'preview-host'))
const copiedPreviewHost=files(publicPreviewHost)
if(JSON.stringify(copiedPreviewHost)!==JSON.stringify(sourcePreviewHost))throw Error('Preview host asset helper did not copy the complete deployment tree')
for(const path of sourcePreviewHost){
  const sourceHash=createHash('sha256').update(readFileSync(join(installed,'preview-host',path))).digest('hex')
  const copyHash=createHash('sha256').update(readFileSync(join(publicPreviewHost,path))).digest('hex')
  if(sourceHash!==copyHash)throw Error('Copied preview host asset changed: '+path)
}
const hostingContract=assets.readPreviewHostHostingContract()
if(JSON.stringify(hostingContract)!==JSON.stringify(JSON.parse(readFileSync(join(installed,'preview-host/hosting.json'),'utf8'))))throw Error('Public preview host contract does not match the verified package contract')

cpSync(resolve(projectRoot,'tests/fixtures/sdk-vite-consumer.ts.txt'),join(consumer,'main.ts'))
writeFileSync(join(consumer,'index.html'),'<!doctype html><script type="module" src="/main.ts"></script>\n')
for(const [module,moduleResolution] of [[ts.ModuleKind.ESNext,ts.ModuleResolutionKind.Bundler],[ts.ModuleKind.NodeNext,ts.ModuleResolutionKind.NodeNext]]){
  const program=ts.createProgram([join(consumer,'main.ts')],{target:ts.ScriptTarget.ES2022,module,moduleResolution,strict:true,noEmit:true,skipLibCheck:false,types:[],lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts']})
  const diagnostics=ts.getPreEmitDiagnostics(program)
  if(diagnostics.length)throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:file=>file,getCurrentDirectory:()=>consumer,getNewLine:()=> '\n'}))
  for(const source of program.getSourceFiles())if(source.fileName.startsWith(join(projectRoot,'src')+sep))throw Error('External typecheck read repository source: '+source.fileName)
}

const output=join(consumer,'dist')
await build({configFile:false,root:consumer,base:'./',worker:{format:'es'},build:{outDir:output,emptyOutDir:true,target:'es2022'}})
for(const path of files(output)){
  const bytes=readFileSync(join(output,path))
  for(const value of forbidden)if(bytes.includes(Buffer.from(value)))throw Error('Vite output contains a repository or SDK build path: '+path)
}

npm(['uninstall','--offline','--ignore-scripts','--no-audit','--no-fund','--no-package-lock',packageJSON.name],consumer)
if(existsSync(join(consumer,'node_modules/@tanstack/browser-sandbox-experimental')))throw Error('npm uninstall retained the installed SDK package')
npm(['install','--offline','--ignore-scripts','--no-audit','--no-fund','--no-package-lock',first.tarball],consumer)
const reinstalled=realpathSync(join(consumer,'node_modules/@tanstack/browser-sandbox-experimental'))
verifySDK(reinstalled)
if(JSON.stringify(files(reinstalled).sort())!==JSON.stringify(installedFiles))throw Error('npm reinstall changed the declared package files')

console.log(JSON.stringify({tarball:basename(first.tarball),sha256:first.sha256,files:summary.files,bytes:summary.bytes,workers:workers.length,agentAcquisitionCancellation:true,reinstall:true,consumer,output},null,2))
