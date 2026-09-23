import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync, existsSync, realpathSync} from 'node:fs'
import {join, dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL, fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {SDK_COMPATIBILITY_POLICY} from '../scripts/sdk-compatibility-policy.mjs'
import {writeSDKReleaseRecords} from '../scripts/sdk-release-record.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))
async function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'sdk-assets-test-'))
  const root = join(temporary, 'package')
  mkdirSync(root)
  cpSync(join(project, 'src/sdk/assets.mjs'), join(root, 'assets.mjs'))
  cpSync(join(project, 'scripts/verify-sdk.mjs'), join(root, 'verify-sdk.mjs'))
  cpSync(join(project, 'scripts/sdk-build-profiles.mjs'), join(root, 'sdk-build-profiles.mjs'))
  cpSync(join(project, 'scripts/sdk-license-policy.mjs'), join(root, 'sdk-license-policy.mjs'))
  cpSync(join(project, 'scripts/sdk-api-compare.mjs'), join(root, 'sdk-api-compare.mjs'))
  cpSync(join(project, 'scripts/check-sdk-release.mjs'), join(root, 'check-sdk-release.mjs'))
  const names = ['bridge.html', 'bridge.js', 'sw.js', 'inspect.js', 'websocket.js', 'request-policy.js']
  const hosting = {separateOrigin: true, secureContext: true, scope: '/', fallbackStatus: 503,
    routes: names.map(name => ({path: '/__sandbox/' + name, file: '__sandbox/' + name, method: 'GET', headers: {
      'Content-Type': name.endsWith('.html') ? 'text/html' : 'text/javascript',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Service-Worker-Allowed': '/',
      ...(name.endsWith('.html') ? {'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"} : {}),
    }}))}
  const shellWasm=Buffer.from('shell fixture')
  const shellHash=createHash('sha256').update(shellWasm).digest('hex')
  const shell={api:'one-shot',implementation:'mvdan.cc/sh/v3',version:'3.14.1',statePersistence:false,terminal:false,numericFdRedirection:'unsupported',externalCommands:'kernel-processes',goBuild:{trimpath:true,ldflags:['-s','-w']},wasmSHA256:shellHash,sourceSHA256:'1'.repeat(64),lockSHA256:'2'.repeat(64)}
  const declarationPath='types/sdk/index.d.ts'
  const declaration='export declare const SDK_COMPATIBILITY: { readonly apiVersion: 1; readonly stability: "experimental" };\n'
  const contract={format:1,apiVersion:1,stability:'experimental',entrypoints:{'.':{types:'./'+declarationPath,exports:[{name:'SDK_COMPATIBILITY',flags:2,declarations:[{path:declarationPath,text:declaration}]}]}},declarations:[{path:declarationPath,bytes:Buffer.byteLength(declaration),sha256:createHash('sha256').update(declaration).digest('hex')}]}
  const contractText=JSON.stringify(contract,null,2)+'\n'
  const contractHash=createHash('sha256').update(contractText).digest('hex')
  const policyText=JSON.stringify(SDK_COMPATIBILITY_POLICY,null,2)+'\n'
  const policyHash=createHash('sha256').update(policyText).digest('hex')
  const packageManifest={name:'fixture',version:'0.0.0',private:true,type:'module',sdkCompatibility:{apiVersion:1,stability:'experimental',contract:'api-contract.json',sha256:contractHash,policy:'compatibility-policy.json'},exports:{'./api-contract':'./api-contract.json','./compatibility-policy':'./compatibility-policy.json','./compare-api':{node:'./sdk-api-compare.mjs'},'./check-release':{node:'./check-sdk-release.mjs'}}}
  const files = new Map([
    ['index.js', 'export {}'], ['package.json', JSON.stringify(packageManifest)],
    ['kernel-host.html','<script type="module" src="./kernel-host.js"></script>'],
    ['kernel-host.js',"new URL('workers/kernel.js',import.meta.url)"],
    [declarationPath,declaration],['api-contract.json',contractText],['compatibility-policy.json',policyText],
    ['preview-host/hosting.json', JSON.stringify(hosting)],
    ...names.map(name => ['preview-host/__sandbox/' + name, name]),
    ['runtime/workers/kernel.js', 'import("./chunks/ffi.js")'],
    ['runtime/workers/compiler.js', "new URL('../compiler/esbuild.wasm',import.meta.url)"],
    ['runtime/workers/chunks/ffi.js', 'export const ffi = true'],
    ['runtime/compiler/esbuild.wasm', new Uint8Array([0, 97, 115, 109])],
    ['runtime/mvdan-shell/shell.wasm', shellWasm],
    ['runtime/mvdan-shell/build.json', JSON.stringify({mvdan:'3.14.1',goBuild:shell.goBuild,wasmSHA256:shellHash,sourceSHA256:shell.sourceSHA256,lockSHA256:shell.lockSHA256})],
  ])
  const coverage={format:1,generatedBundles:{artifacts:['index.js','kernel-host.js','runtime/workers/'],workspace:[],packages:[],notice:'licenses/THIRD-PARTY-NOTICES.txt'},native:[{artifacts:['runtime/compiler/','runtime/mvdan-shell/'],source:'fixture',notice:'licenses/THIRD-PARTY-NOTICES.txt'}],localArtifacts:['api-contract.json','compatibility-policy.json','kernel-host.html','package.json','preview-host/','assets.mjs','verify-sdk.mjs','sdk-api-compare.mjs','sdk-build-profiles.mjs','sdk-license-policy.mjs','check-sdk-release.mjs','size-report.json','types/','licenses/']}
  const coverageText=JSON.stringify(coverage)
  files.set('licenses/THIRD-PARTY-NOTICES.txt','fixture notice')
  files.set('licenses/SHIPPED-INPUTS.json',coverageText)
  const sizeText=JSON.stringify({format:1,fileBytes:0,bundleInputBytes:0,duplicateBytes:0,semanticDuplicateBytes:0,files:[],bundleInputs:[],topContributors:[],exactDuplicates:[],semanticDuplicates:[],distributionPlan:[1,2,3].map(rank=>({rank,paths:['runtime/compiler/'],strategy:'fixture',prerequisite:'fixture',behavior:'fixture'}))})
  files.set('size-report.json',sizeText)
  for (const [path, contents] of files) {
    mkdirSync(dirname(join(root, path)), {recursive: true})
    writeFileSync(join(root, path), contents)
  }
  const paths = [...files.keys(), 'assets.mjs', 'verify-sdk.mjs', 'sdk-api-compare.mjs', 'sdk-build-profiles.mjs', 'sdk-license-policy.mjs', 'check-sdk-release.mjs']
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({experimental: true,apiContract:{path:'api-contract.json',format:1,apiVersion:1,stability:'experimental',sha256:contractHash,exports:{'.':['SDK_COMPATIBILITY']}},compatibilityPolicy:{path:'compatibility-policy.json',format:1,stability:'experimental',sha256:policyHash},attestations:{candidateCompatibility:'candidate-compatibility.json',releaseRecord:'release-record.json'}, shell,sizeReport:{format:1,path:'size-report.json',bytes:Buffer.byteLength(sizeText),sha256:createHash('sha256').update(sizeText).digest('hex')},licenseCoverage:{path:'licenses/SHIPPED-INPUTS.json',sha256:createHash('sha256').update(coverageText).digest('hex'),packageCount:0}, files: paths.map(path => {
    const content = readFileSync(join(root, path))
    return {path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex')}
  })}))
  writeSDKReleaseRecords(root)
  const {copyRuntimeAssets,copyPreviewHostAssets,readPreviewHostHostingContract} = await import(pathToFileURL(join(root, 'assets.mjs')).href)
  return {root, temporary, destination: join(temporary, 'copied-runtime'), copyRuntimeAssets,copyPreviewHostAssets,readPreviewHostHostingContract,hosting}
}

test('copies the complete runtime, including worker chunks and binary assets', async () => {
  const f = await fixture()
  assert.equal(f.copyRuntimeAssets(f.destination), join(realpathSync(f.temporary), 'copied-runtime'))
  for (const path of ['workers/kernel.js', 'workers/chunks/ffi.js', 'compiler/esbuild.wasm']) {
    assert.deepEqual(readFileSync(join(f.destination, path)), readFileSync(join(f.root, 'runtime', path)))
  }
  assert.equal(existsSync(join(f.destination, 'index.js')), false)
})
test('copies the complete verified preview host and exposes its deployment contract', async () => {
  const f = await fixture(),destination=join(f.temporary,'copied-preview-host')
  assert.equal(f.copyPreviewHostAssets(destination),join(realpathSync(f.temporary),'copied-preview-host'))
  assert.deepEqual(readFileSync(join(destination,'hosting.json')),readFileSync(join(f.root,'preview-host/hosting.json')))
  for(const route of f.hosting.routes)assert.deepEqual(readFileSync(join(destination,route.file)),readFileSync(join(f.root,'preview-host',route.file)))
  const first=f.readPreviewHostHostingContract(),second=f.readPreviewHostHostingContract()
  assert.deepEqual(first,f.hosting);assert.notEqual(first,second)
})
test('preview host copy keeps no-overwrite, package-boundary and source-verification checks', async () => {
  const existing=await fixture(),destination=join(existing.temporary,'existing-preview-host')
  mkdirSync(destination);writeFileSync(join(destination,'keep'),'original')
  assert.throws(()=>existing.copyPreviewHostAssets(destination),/EEXIST/)
  assert.equal(readFileSync(join(destination,'keep'),'utf8'),'original')
  const inside=await fixture(),insideTarget=join(inside.root,'preview-host/copy')
  assert.throws(()=>inside.copyPreviewHostAssets(insideTarget),/outside/);assert.equal(existsSync(insideTarget),false)
  const tampered=await fixture(),tamperedTarget=join(tampered.temporary,'tampered-preview-host')
  writeFileSync(join(tampered.root,'preview-host/__sandbox/bridge.js'),'changed')
  assert.throws(()=>tampered.copyPreviewHostAssets(tamperedTarget),/mismatch/);assert.equal(existsSync(tamperedTarget),false)
})
test('rejects an existing destination without changing it', async () => {
  const f = await fixture(); mkdirSync(f.destination); writeFileSync(join(f.destination, 'keep'), 'original')
  assert.throws(() => f.copyRuntimeAssets(f.destination), /EEXIST/)
  assert.equal(readFileSync(join(f.destination, 'keep'), 'utf8'), 'original')
})
test('rejects a destination symlink without touching its target', async () => {
  const f = await fixture(); symlinkSync(f.root, f.destination)
  assert.throws(() => f.copyRuntimeAssets(f.destination), /EEXIST/)
  assert.equal(existsSync(join(f.root, 'workers')), false)
})
test('rejects a destination within the SDK before creation', async () => {
  const f = await fixture(); const target = join(f.root, 'runtime/copy')
  assert.throws(() => f.copyRuntimeAssets(target), /outside/)
  assert.equal(existsSync(target), false)
})
test('rejects missing parents without creating them', async () => {
  const f = await fixture(); const parent = join(f.temporary, 'missing')
  assert.throws(() => f.copyRuntimeAssets(join(parent, 'runtime')), /ENOENT/)
  assert.equal(existsSync(parent), false)
})
for (const kind of ['tampered', 'unlisted', 'symlink']) test('rejects ' + kind + ' source before destination creation', async () => {
  const f = await fixture()
  if (kind === 'tampered') writeFileSync(join(f.root, 'runtime/workers/kernel.js'), 'changed')
  if (kind === 'unlisted') writeFileSync(join(f.root, 'runtime/extra'), 'extra')
  if (kind === 'symlink') symlinkSync('../index.js', join(f.root, 'runtime/link'))
  assert.throws(() => f.copyRuntimeAssets(f.destination), /mismatch|Unlisted|symlink/)
  assert.equal(existsSync(f.destination), false)
})
