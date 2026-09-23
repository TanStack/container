import {lstatSync, readdirSync, readFileSync} from 'node:fs'
import {resolve, join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {verifySDKEngineManifest} from './sdk-build-profiles.mjs'
import {isAlphaSDKVersion,isSupportedSDKLicense} from './sdk-license-policy.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function safePath(path) {
  return typeof path === 'string' && /^[A-Za-z0-9_@./-]+$/.test(path) &&
    !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..')
}

export function verifyRolldownParser(root,claim,seen){
  const prefix='runtime/rolldown-parser/'
  const included=[...seen].filter(path=>path.startsWith(prefix))
  if(claim===undefined){assert(included.length===0,'Native parser files require opt-in manifest metadata');return}
  assert(claim.enabledByDefault===false&&claim.directory==='runtime/rolldown-parser'&&claim.artifact===prefix+'artifact.json'&&claim.version==='1.2.9','Invalid native parser policy')
  assert(seen.has(claim.artifact),'Missing native parser artifact metadata')
  const artifact=JSON.parse(readFileSync(join(root,claim.artifact),'utf8')),encoded=JSON.stringify(artifact)
  assert(!encoded.match(/\/(Users|private|home|tmp|var)\//),'Native parser metadata contains an absolute path')
  assert(artifact.version===claim.version&&artifact.enabledByDefault===false&&JSON.stringify(artifact.requires)==='["crossOriginIsolated","SharedArrayBuffer"]','Invalid native parser artifact identity')
  const bundling=JSON.stringify(artifact.operations)==='["parse","callable.create","callable.resolve","callable.invoke","callable.update","callable.dispose","bundler.create","bundler.run","bundler.context","bundler.close"]'
  if(bundling){
    const bundler=artifact.bundler
    assert(bundler&&Object.keys(bundler).sort().join(',')==='experimental,methods,requiresOwnerWorkspace'&&bundler.experimental===true&&bundler.requiresOwnerWorkspace===true&&JSON.stringify(bundler.methods)==='["generate","write","scan"]','Invalid native bundler capability inventory')
  }else assert(artifact.bundler===undefined,'Native bundler capabilities require matching operations')
  const operations=JSON.stringify(bundling?artifact.operations.slice(0,6):artifact.operations)
  if(operations==='["parse"]')assert(artifact.callable===undefined,'Parse-only artifact cannot claim callable operations')
  else{
    const invokes=operations==='["parse","callable.create","callable.resolve","callable.invoke","callable.update","callable.dispose"]'
    assert(invokes||operations==='["parse","callable.create","callable.resolve","callable.update","callable.dispose"]','Invalid native compiler operation inventory')
    const callable=artifact.callable
    const keys=(invokes?['builtin','callbacks','invokeHooks','requiresOwnerWorkspace','resolveHook','update']:['builtin','callbacks','requiresOwnerWorkspace','resolveHook','update']).concat(callable?.builtins===undefined?[]:['builtins']).sort().join(',')
    assert(callable&&Object.keys(callable).sort().join(',')===keys&&callable.builtin==='builtin:vite-resolve'&&callable.requiresOwnerWorkspace===true&&callable.resolveHook==='resolveId','Invalid native callable capability inventory')
    if(invokes)assert(JSON.stringify(callable.invokeHooks)==='["load","transform"]','Invalid native callable invoke hook inventory')
    if(callable.builtins!==undefined)assert(invokes&&JSON.stringify(callable.builtins)==='["builtin:vite-resolve","builtin:oxc-runtime","builtin:vite-json"]','Invalid native callable builtin inventory')
    assert(callable.update&&callable.update.hook==='watchChange'&&((Object.keys(callable.update).sort().join(',')==='event,files,hook'&&callable.update.files==='existing'&&callable.update.event==='update')||(Object.keys(callable.update).sort().join(',')==='events,files,hook'&&callable.update.files==='mirror'&&JSON.stringify(callable.update.events)==='["create","update","delete"]')),'Invalid native callable workspace update inventory')
    assert(JSON.stringify(callable.callbacks)==='["resolveSubpathImports","onWarn","onDebug","finalizeBareSpecifier","finalizeOtherSpecifiers"]','Invalid native callable callback inventory')
  }
  const resources=artifact.resources
  assert(resources?.full?.initialPages===4096&&resources.full.maximumPages===20480&&resources.full.maxWorkers===8&&resources.full.asyncWorkPoolSize===4&&resources.sync?.initialPages===1024&&resources.sync.maximumPages===8192&&resources.sync.maxWorkers===2&&resources.sync.asyncWorkPoolSize===1&&resources.accounting==='Separate native compiler reservations, not included in the guest memory limit'&&JSON.stringify(resources)===JSON.stringify(claim.resources),'Invalid native parser resource reservation')
  const names=['parser.wasm','pthread.js','worker.js']
  assert(JSON.stringify(Object.keys(artifact.assets??{}).sort())===JSON.stringify(names)&&JSON.stringify(claim.assets)===JSON.stringify(artifact.assets),'Invalid native parser asset list')
  assert(included.length===4&&names.every(name=>seen.has(prefix+name)),'Unexpected native parser packaged files')
  for(const name of names){
    const expected=artifact.assets[name]
    assert(/^[a-f0-9]{64}$/.test(expected)&&createHash('sha256').update(readFileSync(join(root,prefix+name))).digest('hex')===expected,'Native parser asset hash mismatch: '+name)
  }
  assert(/^[a-f0-9]{64}$/.test(artifact.lockSHA256),'Missing native parser lock provenance')
  for(const field of ['inputs','sources']){
    assert(artifact[field]&&Object.keys(artifact[field]).length>0,'Missing native parser '+field)
    for(const [path,hash]of Object.entries(artifact[field]))assert(safePath(path)&&/^[a-f0-9]{64}$/.test(hash),'Invalid native parser input provenance')
  }
  assert(artifact.inputs['@rolldown/binding-wasm32-wasi/rolldown-binding.wasm32-wasi.wasm']===artifact.assets['parser.wasm'],'Native parser WASM input mismatch')
  for(const name of ['ROLLDOWN-LICENSE','ROLLDOWN-THIRD-PARTY-LICENSE'])assert(seen.has('licenses/'+name),'Missing native parser notice: '+name)
}

function verifyLicenseCoverage(root,manifest,seen){
  const claim=manifest.licenseCoverage
  assert(claim&&claim.path==='licenses/SHIPPED-INPUTS.json'&&Number.isSafeInteger(claim.packageCount),'Missing SDK license coverage metadata')
  const bytes=readFileSync(join(root,claim.path))
  assert(createHash('sha256').update(bytes).digest('hex')===claim.sha256,'SDK shipped-input map hash mismatch')
  const coverage=JSON.parse(bytes),encoded=JSON.stringify(coverage)
  assert(coverage.format===1&&!encoded.includes(root)&&!encoded.match(/\/(Users|private|home|tmp|var)\//),'SDK shipped-input map contains an absolute path')
  const notices=[]
  for(const item of coverage.native??[])notices.push(...(item.notices??[]),...(item.notice?[item.notice]:[]))
  notices.push(coverage.generatedBundles?.notice)
  for(const path of notices)assert(safePath(path)&&seen.has(path),'Missing shipped-input notice: '+path)
  assert(coverage.generatedBundles.packages.length===claim.packageCount,'SDK package notice count mismatch')
  if(manifest.projectLicense){
    const projectLicense=coverage.projectLicense
    assert(projectLicense?.path===manifest.projectLicense.path&&projectLicense.spdx===manifest.projectLicense.spdx&&projectLicense.sha256===manifest.projectLicense.sha256,'SDK shipped-input project license mismatch')
  }else assert(coverage.projectLicense===undefined,'Private SDK candidate cannot claim a shipped-input project license')
  const prefixes=[...(coverage.generatedBundles.artifacts??[]),...(coverage.native??[]).flatMap(item=>item.artifacts??[]),...(coverage.localArtifacts??[])]
  for(const path of seen)assert(prefixes.some(prefix=>prefix.endsWith('/')?path.startsWith(prefix):path===prefix),'Uncovered shipped SDK file: '+path)
}

function verifyAPIContract(root,manifest,seen){
  const claim=manifest.apiContract
  assert(claim?.path==='api-contract.json'&&claim.format===1&&Number.isSafeInteger(claim.apiVersion)&&claim.apiVersion>0&&claim.stability==='experimental','Invalid SDK API contract metadata')
  assert(claim.exports&&typeof claim.exports==='object','Invalid SDK API export list')
  const bytes=readFileSync(join(root,claim.path))
  assert(createHash('sha256').update(bytes).digest('hex')===claim.sha256,'SDK API contract hash mismatch')
  const contract=JSON.parse(bytes),encoded=JSON.stringify(contract)
  assert(contract.format===claim.format&&contract.apiVersion===claim.apiVersion&&contract.stability===claim.stability,'SDK API contract identity mismatch')
  assert(!encoded.includes(root)&&!encoded.match(/\/(Users|private|home|tmp|var)\//),'SDK API contract contains an absolute path')
  for(const [entrypoint,names] of Object.entries(claim.exports)){
    const exports=contract.entrypoints?.[entrypoint]?.exports
    assert(Array.isArray(names)&&names.length===new Set(names).size&&Array.isArray(exports)&&JSON.stringify(exports.map(item=>item.name))===JSON.stringify(names),'SDK API exports do not match manifest: '+entrypoint)
  }
  const packageManifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
  assert(JSON.stringify(packageManifest.sdkCompatibility)===JSON.stringify({apiVersion:claim.apiVersion,stability:claim.stability,contract:claim.path,sha256:claim.sha256,policy:'compatibility-policy.json'}),'Package SDK compatibility metadata mismatch')
  assert(packageManifest.exports?.['./api-contract']==='./'+claim.path&&packageManifest.exports?.['./compatibility-policy']==='./compatibility-policy.json'&&packageManifest.exports?.['./compare-api']?.node==='./sdk-api-compare.mjs'&&packageManifest.exports?.['./check-release']?.node==='./check-sdk-release.mjs','Missing public API contract tooling exports')
  const declarations=new Set()
  for(const item of contract.declarations??[]){
    assert(safePath(item.path)&&item.path.endsWith('.d.ts')&&!declarations.has(item.path)&&seen.has(item.path),'Invalid API declaration path: '+item.path)
    declarations.add(item.path)
    const declaration=readFileSync(join(root,item.path))
    assert(declaration.length===item.bytes&&createHash('sha256').update(declaration).digest('hex')===item.sha256,'API declaration hash mismatch: '+item.path)
  }
  for(const entry of Object.values(contract.entrypoints))assert(declarations.has(entry.types.replace(/^\.\//,'')),'API entry declaration is missing from contract')
}

function verifyProjectLicense(root,manifest,seen){
  const packageManifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
  if(packageManifest.sdkDistribution==='internal-staging'){
    assert(packageManifest.private===true&&packageManifest.publishConfig===undefined,'Internal staging must not be publishable')
    assert(JSON.parse(readFileSync(join(root,'api-contract.json'),'utf8')).scope==='internal-staging','Staging API contract must be marked internal')
    if(packageManifest.license===undefined){
      assert(packageManifest.version==='0.0.0'&&manifest.projectLicense===undefined&&!seen.has('LICENSE'),'Unlicensed staging must use the private development identity')
    }else{
      assert((packageManifest.version==='0.0.0'||isAlphaSDKVersion(packageManifest.version))&&isSupportedSDKLicense(packageManifest.license),'Licensed staging requires development or explicit alpha metadata')
      const claim=manifest.projectLicense
      assert(claim?.path==='LICENSE'&&claim.spdx===packageManifest.license&&seen.has('LICENSE'),'Staging project license metadata mismatch')
      assert(createHash('sha256').update(readFileSync(join(root,'LICENSE'))).digest('hex')===claim.sha256,'Staging project license hash mismatch')
    }
    return
  }
  if(packageManifest.private===true){
    assert(packageManifest.version==='0.0.0','Private SDK candidate must use version 0.0.0')
    assert(packageManifest.license===undefined&&manifest.projectLicense===undefined&&!seen.has('LICENSE'),'Private SDK candidate cannot claim a project license')
    return
  }
  const claim=manifest.projectLicense
  assert(packageManifest.private!==true&&isAlphaSDKVersion(packageManifest.version),'Public SDK requires an explicit alpha semantic version')
  assert(isSupportedSDKLicense(packageManifest.license),'Public SDK requires one supported SPDX license identifier')
  assert(packageManifest.publishConfig?.access==='public','Scoped public SDK requires public npm access')
  assert(claim?.path==='LICENSE'&&claim.spdx===packageManifest.license&&seen.has('LICENSE'),'Public SDK project license metadata mismatch')
  const bytes=readFileSync(join(root,'LICENSE'))
  assert(/^[a-f0-9]{64}$/.test(claim.sha256)&&createHash('sha256').update(bytes).digest('hex')===claim.sha256,'Public SDK project license hash mismatch')
}

function verifyCompatibilityPolicy(root,manifest,seen){
  const claim=manifest.compatibilityPolicy
  assert(claim?.path==='compatibility-policy.json'&&claim.format===1&&claim.stability==='experimental'&&seen.has(claim.path),'Missing experimental compatibility policy')
  const bytes=readFileSync(join(root,claim.path))
  assert(createHash('sha256').update(bytes).digest('hex')===claim.sha256,'Compatibility policy hash mismatch')
  const policy=JSON.parse(bytes)
  assert(policy.format===1&&policy.stability==='experimental'&&policy.apiVersion?.monotonic===true,'Invalid compatibility policy identity')
  assert(policy.versionRule?.additive==='apiVersion must stay unchanged'&&policy.versionRule?.breaking==='apiVersion must increase','Invalid apiVersion rules')
  assert(Array.isArray(policy.declarations?.additive)&&Array.isArray(policy.declarations?.breaking)&&Array.isArray(policy.runtimeAssets?.breaking)&&Array.isArray(policy.hosting?.breaking)&&Array.isArray(policy.buildProfile?.breaking),'Incomplete compatibility policy')
}

function verifySizeReport(root,manifest,seen){
  const claim=manifest.sizeReport
  assert(claim?.path==='size-report.json'&&claim.format===1,'Missing SDK size report metadata')
  const bytes=readFileSync(join(root,claim.path))
  assert(bytes.length===claim.bytes&&createHash('sha256').update(bytes).digest('hex')===claim.sha256,'SDK size report hash mismatch')
  const report=JSON.parse(bytes),encoded=JSON.stringify(report)
  assert(report.format===1&&!encoded.includes(root)&&!encoded.match(/\/(Users|private|home|tmp|var)\//),'Invalid SDK size report')
  assert(Array.isArray(report.files)&&Array.isArray(report.bundleInputs)&&Array.isArray(report.topContributors)&&Array.isArray(report.exactDuplicates)&&Array.isArray(report.semanticDuplicates)&&Array.isArray(report.distributionPlan),'Invalid SDK size report entries')
  const paths=report.files.map(item=>item.path)
  assert(JSON.stringify(paths)===JSON.stringify([...paths].sort())&&paths.length===new Set(paths).size,'SDK size report files are not deterministic')
  let total=0
  for(const item of report.files){
    assert(seen.has(item.path)&&item.path!=='size-report.json'&&Number.isSafeInteger(item.bytes)&&item.bytes>=0&&/^[a-f0-9]{64}$/.test(item.sha256),'Invalid SDK size report file: '+item.path)
    const content=readFileSync(join(root,item.path));assert(content.length===item.bytes&&createHash('sha256').update(content).digest('hex')===item.sha256,'SDK size report file mismatch: '+item.path);total+=item.bytes
  }
  assert(total===report.fileBytes,'SDK size report total mismatch')
  const inputs=report.bundleInputs.map(item=>item.path)
  assert(JSON.stringify(inputs)===JSON.stringify([...inputs].sort())&&inputs.length===new Set(inputs).size,'SDK size report inputs are not deterministic')
  assert(report.bundleInputBytes===report.bundleInputs.reduce((sum,item)=>sum+item.bytes,0),'SDK size report input total mismatch')
  for(const item of report.bundleInputs)assert(safePath(item.path)&&Number.isSafeInteger(item.bytes)&&item.bytes>=0&&/^[a-f0-9]{64}$/.test(item.sha256),'Invalid SDK build input: '+item.path)
  const top=[...report.files].sort((a,b)=>b.bytes-a.bytes||a.path.localeCompare(b.path)).slice(0,20)
  assert(JSON.stringify(report.topContributors)===JSON.stringify(top),'SDK top contributors are not deterministic')
  const groups=new Map()
  for(const item of report.files){const group=groups.get(item.sha256)??[];group.push(item);groups.set(item.sha256,group)}
  const duplicates=[...groups.entries()].filter(([,group])=>group.length>1).map(([sha256,group])=>({sha256,bytesEach:group[0].bytes,copies:group.length,avoidableBytes:group[0].bytes*(group.length-1),paths:group.map(item=>item.path).sort()})).sort((a,b)=>b.avoidableBytes-a.avoidableBytes||a.sha256.localeCompare(b.sha256))
  assert(JSON.stringify(report.exactDuplicates)===JSON.stringify(duplicates)&&report.duplicateBytes===duplicates.reduce((sum,item)=>sum+item.avoidableBytes,0),'SDK duplicate accounting is not deterministic')
  const semanticGroups=new Map()
  for(const item of report.files.filter(item=>item.path.endsWith('/core.mjs'))){const normalized=readFileSync(join(root,item.path),'utf8').replace(/quickjs-stacktrace-[A-Za-z0-9]+/g,'quickjs-stacktrace-ID'),normalizedSHA256=createHash('sha256').update(normalized).digest('hex'),group=semanticGroups.get(normalizedSHA256)??[];group.push(item);semanticGroups.set(normalizedSHA256,group)}
  const semanticDuplicates=[...semanticGroups.entries()].filter(([,group])=>group.length>1&&new Set(group.map(item=>item.sha256)).size>1).map(([normalizedSHA256,group])=>({normalizedSHA256,normalization:'quickjs-stacktrace temporary directory token',bytesEach:group[0].bytes,copies:group.length,avoidableBytes:group[0].bytes*(group.length-1),paths:group.map(item=>item.path).sort()})).sort((a,b)=>b.avoidableBytes-a.avoidableBytes||a.normalizedSHA256.localeCompare(b.normalizedSHA256))
  assert(JSON.stringify(report.semanticDuplicates)===JSON.stringify(semanticDuplicates)&&report.semanticDuplicateBytes===semanticDuplicates.reduce((sum,item)=>sum+item.avoidableBytes,0),'SDK semantic duplicate accounting is not deterministic')
  assert(report.distributionPlan.length===3&&report.distributionPlan.every((item,index)=>item.rank===index+1&&Array.isArray(item.paths)&&item.paths.every(path=>safePath(path.replace(/\/$/,'')))&&typeof item.strategy==='string'&&typeof item.prerequisite==='string'&&typeof item.behavior==='string'),'Invalid SDK distribution split plan')
}

function verifyReleaseRecords(root,manifest,manifestBytes,actual){
  const expected={candidateCompatibility:'candidate-compatibility.json',releaseRecord:'release-record.json'}
  assert(JSON.stringify(manifest.attestations)===JSON.stringify(expected),'Missing SDK release attestations')
  const manifestSHA256=createHash('sha256').update(manifestBytes).digest('hex')
  const compatibilityBytes=readFileSync(join(root,expected.candidateCompatibility))
  const compatibility=JSON.parse(compatibilityBytes)
  const buildProfile=manifest.buildProfile??'default'
  assert(compatibility.format===1&&compatibility.artifact?.manifest==='manifest.json'&&compatibility.artifact.manifestSHA256===manifestSHA256&&compatibility.artifact.buildProfile===buildProfile,'Candidate compatibility record does not match this manifest')
  assert(compatibility.historicalEvidence?.document==='COMPATIBILITY.md'&&compatibility.historicalEvidence.appliedToCandidate===false,'Historical compatibility evidence must remain separate')
  const browsers=['chromium','firefox','safari','playwright-webkit'],workflows=['vite','start'],phases=['cold','resume']
  assert(JSON.stringify(Object.keys(compatibility.browsers??{}))===JSON.stringify(browsers)&&compatibility.browsers.safari.kind==='Actual Safari desktop'&&compatibility.browsers['playwright-webkit'].notSafariEvidence===true,'Invalid candidate browser inventory')
  for(const browser of browsers)for(const workflow of workflows)for(const phase of phases){
    const cell=compatibility.results?.[browser]?.[workflow]?.[phase]
    assert(cell&&['passed','failed','unverified'].includes(cell.status),'Invalid candidate compatibility cell')
    if(cell.status==='unverified')assert(JSON.stringify(cell)==='{"status":"unverified"}','Unverified compatibility cell cannot contain evidence')
    else assert(Array.isArray(cell.evidence)&&cell.evidence.length>0&&cell.evidence.every(item=>typeof item==='string'&&item.length>0),'Verified compatibility cell requires evidence')
  }
  const release=JSON.parse(readFileSync(join(root,expected.releaseRecord),'utf8'))
  const packageJSON=JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
  assert(release.format===1&&release.status==='candidate'&&release.artifact?.manifestSHA256===manifestSHA256&&release.artifact.buildProfile===buildProfile,'Release record does not match this manifest')
  assert(JSON.stringify(release.package)===JSON.stringify({name:packageJSON.name,version:packageJSON.version,private:packageJSON.private===true,license:packageJSON.license??null,publishAccess:packageJSON.publishConfig?.access??null}),'Release package identity mismatch')
  assert(release.compatibility?.path===expected.candidateCompatibility&&release.compatibility.sha256===createHash('sha256').update(compatibilityBytes).digest('hex'),'Release compatibility record hash mismatch')
  if(release.source?.kind==='unavailable')assert(release.source.revision===null&&release.source.archive===null,'Invalid unavailable source record')
  else assert(release.source?.kind==='source-archive'&&/^sha256:[a-f0-9]{64}$/.test(release.source.revision)&&release.source.revision===`sha256:${release.source.archive?.sha256}`&&typeof release.source.archive.file==='string'&&release.source.archive.file.length>0&&Number.isSafeInteger(release.source.archive.bytes)&&release.source.archive.bytes>0,'Invalid source archive record')
  assert(release.publication?.published===false&&release.publication.registry===null&&release.publication.tarballSHA256===null,'Candidate release record cannot claim publication')
  for(const path of Object.values(expected))assert(actual.has(path),'Missing SDK release attestation: '+path)
  return new Set(Object.values(expected))
}

export function inspectSDKFSCopy(directory){
  const artifact=JSON.parse(readFileSync(join(directory,'runtime/kernel-runtime/builtins.json'),'utf8'))
  assert(artifact.version===2&&artifact.assets&&typeof artifact.assets==='object','Unsupported packaged builtin artifact')
  const runtimeBuild=JSON.parse(readFileSync(join(directory,'runtime/kernel-runtime/build.json'),'utf8'))
  for(const [name,asset] of Object.entries(artifact.assets)){
    assert(asset&&typeof asset.path==='string'&&/^kernel-runtime\/[A-Za-z0-9._-]+$/.test(asset.path),'Invalid packaged builtin asset: '+name)
    const bytes=readFileSync(join(directory,'runtime',asset.path)),claim=runtimeBuild.assets?.[name]
    assert(claim?.path===asset.path&&claim.bytes===bytes.length&&claim.sha256===createHash('sha256').update(bytes).digest('hex'),'Packaged builtin asset mismatch: '+name)
  }
  for(const [name,required] of [['node:fs',['cp','cpSync']],['node:fs/promises',['cp']]]){
    const module=artifact.modules?.[name]
    assert(module&&typeof module.cjs==='string'&&required.every(key=>module.exports?.includes(key)), 'Missing packaged filesystem copy exports: '+name)
  }
  return {status:'subset',entrypoints:['node:fs.cp','node:fs.cpSync','node:fs/promises.cp'],
    recursive:true,asyncFilter:true,force:true,errorOnExist:true,sourceSymlinks:['resolve-target','verbatim','dereference'],
    unsupported:['preserveTimestamps:true','nonzero mode','replace destination symlink','special files'],
    evidence:'source parity and emitted builtin integration tests; not full Node conformance',
  }
}

export function verifySDK(directory) {
  const root = resolve(directory)
  assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'SDK root must be a real directory')
  const actual = new Map()
  function visit(relative = '') {
    for (const name of readdirSync(join(root, relative))) {
      const path = relative ? relative + '/' + name : name
      assert(safePath(path), 'Unsafe artifact path: ' + path)
      const stat = lstatSync(join(root, path))
      assert(!stat.isSymbolicLink(), 'SDK symlink: ' + path)
      if (stat.isDirectory()) visit(path)
      else {
        assert(stat.isFile(), 'Unsupported SDK artifact: ' + path)
        actual.set(path, stat.size)
      }
    }
  }
  visit()
  assert(![...actual.keys()].some(path => path.startsWith('runtime/workers/assets/')), 'Nested worker assets duplicate packaged runtimes')
  assert(actual.has('manifest.json'), 'Missing manifest.json')
  const manifestBytes=readFileSync(join(root, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  assert(manifest.experimental === true && Array.isArray(manifest.files), 'Invalid SDK manifest')
  const seen = new Set()
  let bytes = 0
  for (const entry of manifest.files) {
    assert(entry && safePath(entry.path) && entry.path !== 'manifest.json', 'Unsafe manifest path')
    assert(!seen.has(entry.path), 'Duplicate manifest path: ' + entry.path)
    seen.add(entry.path)
    assert(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid file metadata: ' + entry.path)
    assert(actual.has(entry.path), 'Missing artifact: ' + entry.path)
    const content = readFileSync(join(root, entry.path))
    assert(content.length === entry.bytes, 'Byte count mismatch: ' + entry.path)
    assert(createHash('sha256').update(content).digest('hex') === entry.sha256, 'SHA256 mismatch: ' + entry.path)
    bytes += content.length
  }
  const attestations=verifyReleaseRecords(root,manifest,manifestBytes,actual)
  for (const path of actual.keys()) assert(path === 'manifest.json' || seen.has(path)||attestations.has(path), 'Unlisted artifact: ' + path)
  verifyLicenseCoverage(root,manifest,seen)
  verifyProjectLicense(root,manifest,seen)
  verifyAPIContract(root,manifest,seen)
  verifyCompatibilityPolicy(root,manifest,seen)
  verifySizeReport(root,manifest,seen)
  verifySDKEngineManifest(root, manifest)
  verifyRolldownParser(root,manifest.experimentalRolldownParser,seen)
  if(manifest.fsCopy!==undefined)assert(JSON.stringify(manifest.fsCopy)===JSON.stringify(inspectSDKFSCopy(root)),'Invalid filesystem copy compatibility metadata')
  const shell=manifest.shell
  assert(shell?.api==='one-shot'&&shell.implementation==='mvdan.cc/sh/v3'&&shell.version==='3.14.1','Invalid shell compatibility metadata')
  assert(shell.statePersistence===false&&shell.terminal===false&&shell.numericFdRedirection==='unsupported'&&shell.externalCommands==='kernel-processes','Invalid shell capability metadata')
  for(const key of ['wasmSHA256','sourceSHA256','lockSHA256'])assert(/^[a-f0-9]{64}$/.test(shell[key]),'Invalid shell hash: '+key)
  const shellBuild=JSON.parse(readFileSync(join(root,'runtime/mvdan-shell/build.json'),'utf8'))
  assert(JSON.stringify(shell.goBuild)===JSON.stringify({trimpath:true,ldflags:['-s','-w']})&&JSON.stringify(shellBuild.goBuild)===JSON.stringify(shell.goBuild),'Shell WASM must remove build paths, symbols and DWARF data')
  assert(shellBuild.mvdan===shell.version&&shellBuild.wasmSHA256===shell.wasmSHA256&&shellBuild.sourceSHA256===shell.sourceSHA256&&shellBuild.lockSHA256===shell.lockSHA256,'Shell metadata does not match packaged artifacts')
  const shellWasm=readFileSync(join(root,'runtime/mvdan-shell/shell.wasm'))
  assert(createHash('sha256').update(shellWasm).digest('hex')===shell.wasmSHA256,'Shell WASM hash mismatch')
  for (const path of ['index.js', 'kernel-host.html', 'kernel-host.js', 'package.json', 'preview-host/hosting.json']) assert(seen.has(path), 'Missing SDK entry: ' + path)
  const kernelHostHTML=readFileSync(join(root,'kernel-host.html'),'utf8')
  assert(/<script\s+type=["']module["']\s+src=["']\.\/kernel-host\.js["']\s*><\/script>/.test(kernelHostHTML),'Kernel host HTML must load the packaged module entry')
  const kernelHostJS=readFileSync(join(root,'kernel-host.js'),'utf8')
  assert(kernelHostJS.includes('workers/')&&kernelHostJS.includes('kernel'),'Kernel host does not reference the packaged kernel worker factory')
  assert(!kernelHostJS.includes('kernel.worker'),'Kernel host contains a consumer-bundled kernel worker')
  assert(seen.has('runtime/compiler/esbuild.wasm'), 'Missing external compiler WASM')
  const compilerWasm=readFileSync(join(root,'runtime/compiler/esbuild.wasm'))
  assert(compilerWasm.length>=4&&compilerWasm.subarray(0,4).equals(Buffer.from([0,97,115,109])), 'Invalid external compiler WASM')
  if(manifest.experimentalCompiler!==undefined){
    const policy=manifest.experimentalCompiler
    assert(policy.enabledByDefault===false&&policy.worker==='runtime/workers/browser-compiler.js'&&policy.artifact==='runtime/compiler/artifact.json','Invalid experimental compiler policy')
    assert(seen.has(policy.worker)&&seen.has(policy.artifact)&&seen.has('runtime/compiler/GO-LICENSE'),'Missing experimental compiler artifacts')
    const artifact=JSON.parse(readFileSync(join(root,policy.artifact),'utf8'))
    assert(policy.version===artifact.version&&policy.runtimeSHA256===artifact.hashes['wasm_exec.js'],'Experimental compiler provenance mismatch')
    assert(/^[a-f0-9]{64}$/.test(policy.runtimeSHA256),'Invalid experimental compiler runtime hash')
    assert(createHash('sha256').update(compilerWasm).digest('hex')===artifact.hashes['esbuild.wasm'],'Experimental compiler WASM mismatch')
  }
  assert(seen.has('runtime/workers/compiler.js')&&readFileSync(join(root,'runtime/workers/compiler.js'),'utf8').includes('../compiler/esbuild.wasm'), 'Compiler worker does not reference external WASM')
  const hosting = JSON.parse(readFileSync(join(root, 'preview-host/hosting.json'), 'utf8'))
  assert(hosting.separateOrigin === true && hosting.secureContext === true && hosting.scope === '/' && hosting.fallbackStatus === 503, 'Unsafe preview hosting policy')
  assert(hosting.embedderPolicy === undefined || hosting.embedderPolicy === 'require-corp', 'Unsupported preview embedder policy')
  if(hosting.embedderPolicy)assert(hosting.fallbackHeaders?.['Cross-Origin-Embedder-Policy'] === hosting.embedderPolicy, 'Missing preview fallback embedder policy')
  assert(hosting.documentResourcePolicy === undefined || hosting.documentResourcePolicy === 'cross-origin', 'Unsupported preview document resource policy')
  if(hosting.documentResourcePolicy)assert(hosting.embedderPolicy === 'require-corp' && hosting.fallbackHeaders?.['Cross-Origin-Resource-Policy'] === hosting.documentResourcePolicy, 'Missing preview fallback resource policy')
  const names = ['bridge.html', 'bridge.js', 'sw.js', 'inspect.js', 'websocket.js', 'request-policy.js']
  assert(Array.isArray(hosting.routes) && hosting.routes.length === names.length, 'Unexpected preview route count')
  const routes = new Set()
  for (const route of hosting.routes) {
    const name = names.find(name => route.path === '/__sandbox/' + name)
    assert(name && !routes.has(name), 'Unexpected or duplicate preview route')
    routes.add(name)
    assert(route.file === '__sandbox/' + name && route.method === 'GET', 'Unsafe preview route mapping')
    assert(seen.has('preview-host/' + route.file), 'Missing preview bootstrap file')
    const expected = {
      'Content-Type': name.endsWith('.html') ? 'text/html' : 'text/javascript',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Service-Worker-Allowed': '/',
      ...(hosting.embedderPolicy ? {'Cross-Origin-Embedder-Policy': hosting.embedderPolicy} : {}),
      ...(name.endsWith('.html') && hosting.documentResourcePolicy ? {'Cross-Origin-Resource-Policy': hosting.documentResourcePolicy} : {}),
      ...(name.endsWith('.html') ? {'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"} : {}),
    }
    assert(route.headers && Object.keys(route.headers).length === Object.keys(expected).length, 'Unexpected preview headers')
    for (const [key, value] of Object.entries(expected)) assert(route.headers[key] === value, 'Unsafe preview header: ' + key)
  }
  return {files: seen.size, bytes, previewRoutes: routes.size}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert(process.argv.length === 3, 'Usage: node scripts/verify-sdk.mjs SDK_DIRECTORY')
    console.log(JSON.stringify(verifySDK(process.argv[2]), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
