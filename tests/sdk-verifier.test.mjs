import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {verifySDK} from '../scripts/verify-sdk.mjs'
import {sdkEngineDirectories,inspectSDKEngine} from '../scripts/sdk-build-profiles.mjs'
import {SDK_COMPATIBILITY_POLICY} from '../scripts/sdk-compatibility-policy.mjs'
import {writeSDKReleaseRecords} from '../scripts/sdk-release-record.mjs'

function fixture(profile) {
  const root = mkdtempSync(join(tmpdir(), 'sdk-verifier-test-'))
  const names = ['bridge.html', 'bridge.js', 'sw.js', 'inspect.js', 'websocket.js', 'request-policy.js']
  const hosting = {
    separateOrigin: true, secureContext: true, scope: '/', fallbackStatus: 503,
    routes: names.map(name => ({path: '/__sandbox/' + name, file: '__sandbox/' + name, method: 'GET', headers: {
      'Content-Type': name.endsWith('.html') ? 'text/html' : 'text/javascript',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Service-Worker-Allowed': '/',
      ...(name.endsWith('.html') ? {'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"} : {}),
    }})),
  }
  mkdirSync(join(root, 'preview-host/__sandbox'), {recursive: true})
  const paths = ['index.js', 'kernel-host.html', 'kernel-host.js', 'runtime/compiler/esbuild.wasm', 'runtime/workers/compiler.js', ...names.map(name => 'preview-host/__sandbox/' + name)]
  mkdirSync(join(root, 'runtime/compiler'), {recursive: true})
  mkdirSync(join(root, 'runtime/workers'), {recursive: true})
  for (const path of paths) writeFileSync(join(root, path),path==='runtime/compiler/esbuild.wasm'?Buffer.from([0,97,115,109]):path==='runtime/workers/compiler.js'?"new URL('../compiler/esbuild.wasm',import.meta.url)":path==='kernel-host.html'?'<script type="module" src="./kernel-host.js"></script>':path==='kernel-host.js'?"new URL('runtime/workers/kernel.js',import.meta.url)":'fixture')
  mkdirSync(join(root,'types/sdk'),{recursive:true})
  const declarationPath='types/sdk/index.d.ts',declaration='export declare const SDK_COMPATIBILITY: { readonly apiVersion: 1; readonly stability: "experimental" };\n'
  writeFileSync(join(root,declarationPath),declaration)
  const contract={format:1,apiVersion:1,stability:'experimental',entrypoints:{'.':{types:'./'+declarationPath,exports:[{name:'SDK_COMPATIBILITY',flags:2,declarations:[{path:declarationPath,text:declaration}]}]}},declarations:[{path:declarationPath,bytes:Buffer.byteLength(declaration),sha256:createHash('sha256').update(declaration).digest('hex')}]}
  const contractText=JSON.stringify(contract,null,2)+'\n',contractHash=createHash('sha256').update(contractText).digest('hex')
  writeFileSync(join(root,'api-contract.json'),contractText)
  writeFileSync(join(root,'sdk-api-compare.mjs'),'export const compareSDKAPIContracts=()=>({compatible:true})\n')
  writeFileSync(join(root,'check-sdk-release.mjs'),'export const checkSDKRelease=()=>({compatible:true})\n')
  const policyText=JSON.stringify(SDK_COMPATIBILITY_POLICY,null,2)+'\n',policyHash=createHash('sha256').update(policyText).digest('hex')
  writeFileSync(join(root,'compatibility-policy.json'),policyText)
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'fixture',version:'0.0.0',private:true,sdkCompatibility:{apiVersion:1,stability:'experimental',contract:'api-contract.json',sha256:contractHash,policy:'compatibility-policy.json'},exports:{'./api-contract':'./api-contract.json','./compatibility-policy':'./compatibility-policy.json','./compare-api':{node:'./sdk-api-compare.mjs'},'./check-release':{node:'./check-sdk-release.mjs'}}}))
  paths.push('package.json','api-contract.json','compatibility-policy.json','sdk-api-compare.mjs','check-sdk-release.mjs',declarationPath)
  const shellWasm=Buffer.from('shell fixture'),shellHash=createHash('sha256').update(shellWasm).digest('hex'),sourceHash='1'.repeat(64),lockHash='2'.repeat(64)
  mkdirSync(join(root,'runtime/mvdan-shell'),{recursive:true})
  writeFileSync(join(root,'runtime/mvdan-shell/shell.wasm'),shellWasm)
  const goBuild={trimpath:true,ldflags:['-s','-w']}
  writeFileSync(join(root,'runtime/mvdan-shell/build.json'),JSON.stringify({mvdan:'3.14.1',goBuild,wasmSHA256:shellHash,sourceSHA256:sourceHash,lockSHA256:lockHash}))
  paths.push('runtime/mvdan-shell/shell.wasm','runtime/mvdan-shell/build.json')
  const manifest = {experimental: true,apiContract:{path:'api-contract.json',format:1,apiVersion:1,stability:'experimental',sha256:contractHash,exports:{'.':['SDK_COMPATIBILITY']}},compatibilityPolicy:{path:'compatibility-policy.json',format:1,stability:'experimental',sha256:policyHash},attestations:{candidateCompatibility:'candidate-compatibility.json',releaseRecord:'release-record.json'},shell:{api:'one-shot',implementation:'mvdan.cc/sh/v3',version:'3.14.1',statePersistence:false,terminal:false,numericFdRedirection:'unsupported',externalCommands:'kernel-processes',goBuild,wasmSHA256:shellHash,sourceSHA256:sourceHash,lockSHA256:lockHash}, files: []}
  mkdirSync(join(root,'licenses'),{recursive:true})
  const coverage={format:1,scope:'fixture',generatedBundles:{artifacts:['index.js','kernel-host.js','runtime/workers/'],workspace:[],packages:[],notice:'licenses/THIRD-PARTY-NOTICES.txt'},native:[
    {artifacts:['runtime/compiler/','runtime/mvdan-shell/'],source:'fixture',notice:'licenses/THIRD-PARTY-NOTICES.txt'},
    {artifacts:Object.keys(sdkEngineDirectories(profile??'default')).map(slot=>'runtime/'+slot+'/'),source:'fixture',notice:'licenses/THIRD-PARTY-NOTICES.txt'},
  ],localArtifacts:['api-contract.json','compatibility-policy.json','kernel-host.html','package.json','preview-host/','sdk-api-compare.mjs','check-sdk-release.mjs','size-report.json','types/','licenses/']}
  const coverageText=JSON.stringify(coverage)
  writeFileSync(join(root,'licenses/THIRD-PARTY-NOTICES.txt'),'fixture notice')
  writeFileSync(join(root,'licenses/SHIPPED-INPUTS.json'),coverageText)
  paths.push('licenses/THIRD-PARTY-NOTICES.txt','licenses/SHIPPED-INPUTS.json')
  manifest.licenseCoverage={path:'licenses/SHIPPED-INPUTS.json',sha256:createHash('sha256').update(coverageText).digest('hex'),packageCount:0}
  const sizeText=JSON.stringify({format:1,fileBytes:0,bundleInputBytes:0,duplicateBytes:0,semanticDuplicateBytes:0,files:[],bundleInputs:[],topContributors:[],exactDuplicates:[],semanticDuplicates:[],distributionPlan:[1,2,3].map(rank=>({rank,paths:['runtime/compiler/'],strategy:'fixture',prerequisite:'fixture',behavior:'fixture'}))})
  writeFileSync(join(root,'size-report.json'),sizeText);paths.push('size-report.json')
  manifest.sizeReport={format:1,path:'size-report.json',bytes:Buffer.byteLength(sizeText),sha256:createHash('sha256').update(sizeText).digest('hex')}
  if (profile) {
    manifest.buildProfile = profile
    manifest.engines = {}
    for (const slot of Object.keys(sdkEngineDirectories(profile))) {
      const directory = join(root, 'runtime', slot)
      mkdirSync(directory, {recursive: true})
      const bytes = Buffer.from(slot)
      const metadata = {
        wasmSha256: createHash('sha256').update(bytes).digest('hex'), wasmBytes: bytes.length,
        asyncify: slot.includes('asyncify'), optimization: profile === 'default' || (profile === 'sync-o2' && slot.includes('asyncify')) ? 'Oz' : 'O2',
        ...(slot.includes('-wasm') ? {guestWasm: {dispatchBatch: 16, dispatchUnwind: true, heapLoops: true}} : {}),
        generatorQueue: {stageSHA256: 'fixture'}, assignmentParser: {stageSHA256: 'fixture'}, cooperative: {profileYields: true, wasmPoll: 4096},
        requireESM:{stageSHA256:'a'.repeat(64),bindingSHA256:'b'.repeat(64)},
        ...(slot.includes('-fibers')?{atomics:true,fibers:{bindingSHA256:'1'.repeat(64),buildStageSHA256:'2'.repeat(64),stackBytes:524288,quickJSStackBytes:393216,nativeHeadroomBytes:131072,scope:'experimental scheduler-owned QTS_Call and QTS_Eval continuations, not WASM threads'},sharedStorage:{bindingSHA256:'3'.repeat(64),atomicWaitStageSHA256:'4'.repeat(64),buildStageSHA256:'2'.repeat(64),maxBytes:16777216,maxAllocations:256,scope:slot.includes('-wasm')?'group-owned SAB and WASM memory, message leases and single-engine scheduler-owned atomic operations':'engine-owned fixed SAB storage, message leases and native scheduler-owned atomic waits; not shared WASM'}}:{}),
        ...(profile==='sync-o2-vm-modules'&&!slot.includes('asyncify')?{vmModules:{stageSHA256:'1'.repeat(64),bindingSHA256:'2'.repeat(64),guestAPISHA256:'3'.repeat(64),dynamicImportStageSHA256:'4'.repeat(64),maxLiveHandles:32,maxCreatedHandles:4096,maxSourceBytes:1048576,maxSyntheticExports:128,maxPendingImports:32,maxImportBytecodes:4096,scope:'async module graphs and owned module or namespace dynamic import callbacks; no cached data'}}:{}),
      }
      if(['experimental-fibers-simd','experimental-fibers-simd-lazy'].includes(profile)&&slot.includes('-wasm-atomics-fibers'))metadata.guestWasm.simd={experimental:true,foundationSHA256:'a'.repeat(64),operationsSHA256:'b'.repeat(64)}
      if(profile==='experimental-fibers-simd-lazy'&&slot.includes('-wasm-atomics-fibers'))metadata.guestWasm.lazyCompilation={experimental:true,validation:'eager',stageSHA256:'c'.repeat(64)}
      for (const [name, body] of [['build.json', JSON.stringify(metadata)], ['engine.wasm', bytes], ['core.mjs', 'core'], ['engine.mjs', 'loader'], ...(slot.includes('asyncify') ? [['ffi.mjs', 'ffi']] : [])]) {
        writeFileSync(join(directory, name), body)
        paths.push('runtime/' + slot + '/' + name)
      }
      manifest.engines[slot] = inspectSDKEngine(directory, slot, profile)
    }
  }
  function seal() {
    writeFileSync(join(root, 'preview-host/hosting.json'), JSON.stringify(hosting))
    manifest.files = [...paths, 'preview-host/hosting.json'].map(path => {
      const bytes = readFileSync(join(root, path))
      return {path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}
    })
    save()
  }
  function save() {writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));writeSDKReleaseRecords(root)}
  seal()
  return {root, hosting, manifest, paths, seal, save}
}

function publicAlphaFixture({licenseFile=true,version='0.1.0-alpha.1'}={}){
  const f=fixture(),license='fixture project license\n'
  writeFileSync(join(f.root,'package.json'),JSON.stringify({
    name:'fixture',version,license:'MIT',publishConfig:{access:'public'},
    sdkCompatibility:{apiVersion:1,stability:'experimental',contract:'api-contract.json',sha256:f.manifest.apiContract.sha256,policy:'compatibility-policy.json'},
    exports:{'./api-contract':'./api-contract.json','./compatibility-policy':'./compatibility-policy.json','./compare-api':{node:'./sdk-api-compare.mjs'},'./check-release':{node:'./check-sdk-release.mjs'}},
  }))
  if(licenseFile){
    writeFileSync(join(f.root,'LICENSE'),license)
    f.paths.push('LICENSE')
    f.manifest.projectLicense={path:'LICENSE',spdx:'MIT',sha256:createHash('sha256').update(license).digest('hex')}
    const coveragePath=join(f.root,'licenses/SHIPPED-INPUTS.json'),coverage=JSON.parse(readFileSync(coveragePath,'utf8'))
    coverage.localArtifacts.push('LICENSE')
    coverage.projectLicense={path:'LICENSE',spdx:'MIT',sha256:f.manifest.projectLicense.sha256}
    const coverageText=JSON.stringify(coverage)
    writeFileSync(coveragePath,coverageText)
    f.manifest.licenseCoverage.sha256=createHash('sha256').update(coverageText).digest('hex')
  }
  f.seal()
  return f
}

test('accepts a public alpha with a bound project license',()=>{
  verifySDK(publicAlphaFixture().root)
})

test('internal staging keeps release license metadata but cannot be publishable',()=>{
  const f=publicAlphaFixture(),packagePath=join(f.root,'package.json'),contractPath=join(f.root,'api-contract.json')
  const pkg=JSON.parse(readFileSync(packagePath)),contract=JSON.parse(readFileSync(contractPath))
  pkg.private=true;pkg.sdkDistribution='internal-staging';delete pkg.publishConfig
  contract.scope='internal-staging'
  writeFileSync(contractPath,JSON.stringify(contract))
  const digest=createHash('sha256').update(readFileSync(contractPath)).digest('hex')
  f.manifest.apiContract.sha256=digest;pkg.sdkCompatibility.sha256=digest
  writeFileSync(packagePath,JSON.stringify(pkg));f.seal()
  verifySDK(f.root)
  pkg.version='0.0.0';writeFileSync(packagePath,JSON.stringify(pkg));f.seal()
  verifySDK(f.root)
  pkg.publishConfig={access:'public'};writeFileSync(packagePath,JSON.stringify(pkg));f.seal()
  assert.throws(()=>verifySDK(f.root),/Internal staging must not be publishable/)
  delete pkg.publishConfig;pkg.private=false;writeFileSync(packagePath,JSON.stringify(pkg));f.seal()
  assert.throws(()=>verifySDK(f.root),/Internal staging must not be publishable/)
})

test('rejects a public alpha without a LICENSE artifact',()=>{
  assert.throws(()=>verifySDK(publicAlphaFixture({licenseFile:false}).root),/project license metadata mismatch/)
})

test('rejects a public alpha with a tampered LICENSE artifact',()=>{
  const f=publicAlphaFixture()
  writeFileSync(join(f.root,'LICENSE'),'tampered projec license\n')
  assert.throws(()=>verifySDK(f.root),/SHA256 mismatch: LICENSE/)
})

test('rejects project license attribution missing from shipped inputs',()=>{
  const f=publicAlphaFixture(),path=join(f.root,'licenses/SHIPPED-INPUTS.json')
  const coverage=JSON.parse(readFileSync(path,'utf8'))
  delete coverage.projectLicense
  const text=JSON.stringify(coverage)
  writeFileSync(path,text)
  f.manifest.licenseCoverage.sha256=createHash('sha256').update(text).digest('hex')
  f.seal()
  assert.throws(()=>verifySDK(f.root),/shipped-input project license mismatch/)
})

for(const version of ['1.0.0-foo-alpha.1','01.0.0-alpha.1'])test('rejects noncanonical public alpha version '+version,()=>{
  assert.throws(()=>verifySDK(publicAlphaFixture({version}).root),/explicit alpha semantic version/)
})

test('accepts complete artifact and hosting manifests', () => {
  const result = verifySDK(fixture().root)
  assert.equal(result.files, 23)
  assert.equal(result.previewRoutes, 6)
  assert.ok(result.bytes > 0)
})

test('rejects a candidate compatibility claim without explicit evidence',()=>{
  const f=fixture(),path=join(f.root,'candidate-compatibility.json'),record=JSON.parse(readFileSync(path,'utf8'))
  record.results.chromium.vite.cold={status:'passed'}
  writeFileSync(path,JSON.stringify(record))
  assert.throws(()=>verifySDK(f.root),/requires evidence/)
})

test('rejects a release record bound to a different manifest',()=>{
  const f=fixture(),path=join(f.root,'release-record.json'),record=JSON.parse(readFileSync(path,'utf8'))
  record.artifact.manifestSHA256='0'.repeat(64)
  writeFileSync(path,JSON.stringify(record))
  assert.throws(()=>verifySDK(f.root),/does not match this manifest/)
})

test('rejects a kernel host HTML entry that does not load the packaged module',()=>{
  const f=fixture()
  writeFileSync(join(f.root,'kernel-host.html'),'<script type="module" src="https://other.invalid/kernel-host.js"></script>')
  f.seal()
  assert.throws(()=>verifySDK(f.root),/Kernel host HTML/)
})

test('rejects a kernel host bundle that does not use the packaged kernel worker',()=>{
  const f=fixture()
  writeFileSync(join(f.root,'kernel-host.js'),'new Worker("https://other.invalid/kernel.js")')
  f.seal()
  assert.throws(()=>verifySDK(f.root),/packaged kernel worker factory/)
})

function compilerFixture(){
  const f=fixture(),runtimeSHA256='1'.repeat(64)
  const artifact={version:'0.28.2',hashes:{'wasm_exec.js':runtimeSHA256,'esbuild.wasm':createHash('sha256').update(readFileSync(join(f.root,'runtime/compiler/esbuild.wasm'))).digest('hex')}}
  for(const [path,body] of [['runtime/compiler/artifact.json',JSON.stringify(artifact)],['runtime/compiler/GO-LICENSE','Go notice'],['runtime/workers/browser-compiler.js','worker fixture']]){
    writeFileSync(join(f.root,path),body);f.paths.push(path)
  }
  f.manifest.experimentalCompiler={enabledByDefault:false,worker:'runtime/workers/browser-compiler.js',artifact:'runtime/compiler/artifact.json',version:artifact.version,runtimeSHA256}
  f.seal();return f
}
test('accepts explicitly opt-in compiler provenance',()=>{verifySDK(compilerFixture().root)})
test('rejects compiler enabled by default',()=>{
  const f=compilerFixture();f.manifest.experimentalCompiler.enabledByDefault=true;f.save()
  assert.throws(()=>verifySDK(f.root),/Invalid experimental compiler policy/)
})
test('rejects compiler provenance inconsistent with the packaged WASM',()=>{
  const f=compilerFixture(),path=join(f.root,'runtime/compiler/artifact.json'),artifact=JSON.parse(readFileSync(path,'utf8'))
  artifact.hashes['esbuild.wasm']='2'.repeat(64);writeFileSync(path,JSON.stringify(artifact));f.seal()
  assert.throws(()=>verifySDK(f.root),/Experimental compiler WASM mismatch/)
})

test('rejects nested worker assets that duplicate packaged runtimes', () => {
  const f = fixture()
  const path = 'runtime/workers/assets/engine.wasm'
  mkdirSync(join(f.root, 'runtime/workers/assets'), {recursive: true})
  writeFileSync(join(f.root, path), 'duplicate runtime')
  f.paths.push(path)
  f.seal()
  assert.throws(() => verifySDK(f.root), /duplicate packaged runtimes/)
})

test('rejects a size report whose totals were changed',()=>{
  const f=fixture(),path=join(f.root,'size-report.json')
  const report=JSON.parse(readFileSync(path,'utf8'));report.fileBytes++
  const text=JSON.stringify(report);writeFileSync(path,text);f.seal()
  f.manifest.sizeReport={format:1,path:'size-report.json',bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};f.save()
  assert.throws(()=>verifySDK(f.root),/size report total/)
})

test('rejects a shipped artifact with no input or local coverage rule',()=>{
  const f=fixture(),path='unmapped.bin'
  writeFileSync(join(f.root,path),'unmapped');f.paths.push(path);f.seal()
  assert.throws(()=>verifySDK(f.root),/Uncovered shipped SDK file/)
})

test('rejects absolute paths in the shipped-input map',()=>{
  const f=fixture(),path=join(f.root,'licenses/SHIPPED-INPUTS.json')
  const coverage=JSON.parse(readFileSync(path,'utf8'));coverage.generatedBundles.workspace=['/Users/example/source.ts']
  const text=JSON.stringify(coverage);writeFileSync(path,text);f.manifest.licenseCoverage.sha256=createHash('sha256').update(text).digest('hex');f.seal()
  f.manifest.licenseCoverage.sha256=createHash('sha256').update(readFileSync(path)).digest('hex');f.save()
  assert.throws(()=>verifySDK(f.root),/absolute path/)
})

const invalidArtifacts = [
  ['duplicate', f => f.manifest.files.push(f.manifest.files[0]), /Duplicate/],
  ['traversal', f => f.manifest.files[0].path = '../outside', /Unsafe/],
  ['absolute', f => f.manifest.files[0].path = '/outside', /Unsafe/],
  ['encoded traversal', f => f.manifest.files[0].path = '%2e%2e/outside', /Unsafe/],
  ['backslash', f => f.manifest.files[0].path = 'a\\b', /Unsafe/],
  ['manifest self entry', f => f.manifest.files[0].path = 'manifest.json', /Unsafe/],
  ['unlisted file', f => writeFileSync(join(f.root, 'extra.js'), 'extra'), /Unlisted/],
  ['missing file', f => f.manifest.files[0].path = 'missing.js', /Missing artifact/],
  ['byte count', f => f.manifest.files[0].bytes++, /Byte count/],
  ['hash', f => f.manifest.files[0].sha256 = '0'.repeat(64), /SHA256/],
  ['file symlink', f => symlinkSync('index.js', join(f.root, 'link.js')), /symlink/],
  ['directory symlink', f => symlinkSync('preview-host', join(f.root, 'link')), /symlink/],
]
for (const [name, mutate, error] of invalidArtifacts) test('rejects ' + name, () => {
  const f = fixture(); mutate(f); f.save()
  assert.throws(() => verifySDK(f.root), error)
})

const invalidHosting = [
  ['shared origin', h => h.separateOrigin = false],
  ['insecure context', h => h.secureContext = false],
  ['scope', h => h.scope = '/nested/'],
  ['fallback', h => h.fallbackStatus = 200],
  ['missing route', h => h.routes.pop()],
  ['duplicate route', h => h.routes[1] = h.routes[0]],
  ['wildcard', h => h.routes[0].path = '/*'],
  ['mapping traversal', h => h.routes[0].file = '../index.js'],
  ['method', h => h.routes[0].method = '*'],
  ['cache', h => h.routes[0].headers['Cache-Control'] = 'public'],
  ['mime', h => h.routes[1].headers['Content-Type'] = 'text/html'],
  ['sniffing', h => delete h.routes[0].headers['X-Content-Type-Options']],
  ['worker scope', h => h.routes[2].headers['Service-Worker-Allowed'] = '/other/'],
  ['CSP', h => h.routes[0].headers['Content-Security-Policy'] = "default-src *"],
  ['extra header', h => h.routes[0].headers['Set-Cookie'] = 'bad=value'],
]
for (const [name, mutate] of invalidHosting) test('rejects hosting ' + name + ' even with valid hashes', () => {
  const f = fixture(); mutate(f.hosting); f.seal()
  assert.throws(() => verifySDK(f.root), /preview/)
})

for (const profile of ['default', 'cooperative-o2-heap-loops-batch16', 'sync-o2', 'sync-o2-vm-modules','experimental-fibers','experimental-fibers-simd','experimental-fibers-simd-lazy']) test('accepts consistent packaged profile ' + profile, () => {
  verifySDK(fixture(profile).root)
})
const invalidProfiles = [
  ['profile only', m => delete m.engines],
  ['engines only', m => delete m.buildProfile],
  ['unknown profile', m => m.buildProfile = '../candidate'],
  ['null profile', m => m.buildProfile = null],
  ['wrong profile label', m => m.buildProfile = 'cooperative-o2-heap-loops-batch16'],
  ['missing slot', m => delete m.engines['quickjs-als']],
  ['extra slot', m => m.engines['other'] = m.engines['quickjs-als']],
  ['source mapping', m => m.engines['quickjs-als'].sourceDirectory = 'different'],
  ['metadata path', m => m.engines['quickjs-als'].metadataPath = '../build.json'],
  ['metadata hash', m => m.engines['quickjs-als'].metadataSHA256 = '0'.repeat(64)],
  ['wasm hash', m => m.engines['quickjs-als'].wasmSHA256 = '0'.repeat(64)],
  ['wasm size', m => m.engines['quickjs-als'].wasmBytes++],
  ['embedded metadata', m => m.engines['quickjs-als'].metadata.optimization = 'O3'],
  ['embedded mode', m => m.engines['quickjs-als'].metadata.asyncify = true],
]
for (const [name, mutate] of invalidProfiles) test('rejects manifest ' + name + ' without changing any artifact', () => {
  const f = fixture('default'); mutate(f.manifest); f.save()
  assert.throws(() => verifySDK(f.root), /SDK/)
})
test('rejects internally rehashed metadata with the wrong execution mode', () => {
  const f = fixture('default'), path = join(f.root, 'runtime/quickjs-als/build.json')
  const metadata = JSON.parse(readFileSync(path, 'utf8')); metadata.asyncify = true
  writeFileSync(path, JSON.stringify(metadata)); f.seal()
  assert.throws(() => verifySDK(f.root), /runtime slot/)
})
test('rejects legacy manifest with only engines added', () => {
  const f = fixture(); f.manifest.engines = {}; f.save()
  assert.throws(() => verifySDK(f.root), /appear together/)
})
test('rejects default profile relabeled sync-o2 without changing artifact files', () => {
  const f = fixture('default'); f.manifest.buildProfile = 'sync-o2'; f.save()
  assert.throws(() => verifySDK(f.root), /requires O2/)
})
test('rejects sync-o2 source mapping altered to a cooperative candidate', () => {
  const f = fixture('sync-o2')
  f.manifest.engines['quickjs-als-asyncify-cooperative'].sourceDirectory = sdkEngineDirectories('cooperative-o2-heap-loops-batch16')['quickjs-als-asyncify-cooperative']
  f.save()
  assert.throws(() => verifySDK(f.root), /does not match packaged engine/)
})
for(const slot of ['quickjs-als','quickjs-als-wasm'])test('rejects rehashed sync-o2 engine without requireESM '+slot,()=>{
  const f=fixture('sync-o2'),path=join(f.root,'runtime',slot,'build.json')
  const metadata=JSON.parse(readFileSync(path,'utf8'));delete metadata.requireESM
  writeFileSync(path,JSON.stringify(metadata));f.seal()
  assert.throws(()=>verifySDK(f.root),/requires requireESM provenance/)
})
test('accepts the isolated preview contract and rejects missing bootstrap policy',()=>{
  const f=fixture()
  f.hosting.embedderPolicy='require-corp'
  f.hosting.documentResourcePolicy='cross-origin'
  f.hosting.fallbackHeaders={'Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'cross-origin'}
  for(const route of f.hosting.routes)route.headers['Cross-Origin-Embedder-Policy']='require-corp'
  f.hosting.routes[0].headers['Cross-Origin-Resource-Policy']='cross-origin'
  f.seal()
  assert.doesNotThrow(()=>verifySDK(f.root))
  delete f.hosting.routes[0].headers['Cross-Origin-Embedder-Policy']
  f.seal()
  assert.throws(()=>verifySDK(f.root),/preview headers/)
})
test('rejects VM module profile with altered handle limits',()=>{
  const f=fixture('sync-o2-vm-modules')
  const directory=join(f.root,'runtime/quickjs-als'),path=join(directory,'build.json')
  const metadata=JSON.parse(readFileSync(path,'utf8'));metadata.vmModules.maxLiveHandles=33
  writeFileSync(path,JSON.stringify(metadata))
  assert.throws(()=>inspectSDKEngine(directory,'quickjs-als','sync-o2-vm-modules'),/VM module/)
})
