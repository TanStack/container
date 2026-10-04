import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {installedPackageInventory} from './test-sdk-packages.mjs'
import {verifyDeploymentAssets} from './sdk-external-assets.mjs'
import {readPinnedNativeExamples,nativeExampleHash} from './native-example-sources.mjs'
import {verifyCompilerPackageBoundary} from './build-sdk-packages.mjs'

export function nativeReleaseAcceptancePlan({root=process.cwd(),sdk,deployment,env=process.env}){
  assert.ok(typeof sdk==='string'&&sdk.length,'Native acceptance requires an installed SDK')
  assert.ok(typeof deployment==='string'&&deployment.length,'Native acceptance requires a prepared deployment')
  root=resolve(root);sdk=resolve(sdk);deployment=resolve(deployment)
  // Release checks cannot inherit debug, example filters, or reduced gates.
  const inherited=Object.fromEntries(Object.entries(env).filter(([name])=>!name.startsWith('NATIVE_')&&name!=='TANSTACK_ROUTER_SOURCE'))
  return ['chromium','firefox','webkit'].map(browser=>({browser,
    command:process.execPath,
    args:['--test','--test-force-exit','--test-timeout=180000',join(root,'tests/native-owner-sdk.test.mjs')],
    options:{cwd:root,stdio:'inherit',env:{...inherited,
      NATIVE_SDK_BUNDLE_DIR:sdk,NATIVE_DEPLOYMENT_DIR:deployment,
      NATIVE_OWNER_RUNTIME_CATALOG:'1',NATIVE_OWNER_PINNED_EXAMPLES:'1',NATIVE_TEST_BROWSER:browser}},
  }))
}

export function nativeReleaseAcceptanceIdentity(root,sdk,deployment){
  installedPackageInventory(sdk)
  const require=createRequire(join(sdk,'package.json'))
  const runtime=dirname(require.resolve('@tanstack/browser-sandbox-runtime-experimental/setup'))
  installedPackageInventory(runtime)
  verifyCompilerPackageBoundary(sdk,runtime)
  const profile=JSON.parse(readFileSync(join(runtime,'runtime-profile.json'),'utf8'))
  const contract=JSON.parse(readFileSync(join(sdk,'api-contract.json'),'utf8'))
  assert.equal(profile.buildProfile,'native','Release acceptance requires a native-only runtime')
  assert.equal(contract.apiVersion,8,'Release acceptance requires native API 8')
  const exports=contract.entrypoints['.'].exports.map(item=>item.name)
  for(const name of ['NativeOwnerClient','AgentSession','NativeAgentBackend'])assert.ok(exports.includes(name),'Missing native export: '+name)
  for(const name of ['WorkerKernel','HostedKernel','runShell'])assert.equal(exports.includes(name),false,'Legacy release export: '+name)
  const sdkPackage=JSON.parse(readFileSync(join(sdk,'package.json'),'utf8'))
  const runtimePackage=JSON.parse(readFileSync(join(runtime,'package.json'),'utf8'))
  assert.equal(sdkPackage.name,'@tanstack/browser-sandbox-experimental')
  assert.equal(runtimePackage.name,'@tanstack/browser-sandbox-runtime-experimental')
  assert.equal(sdkPackage.dependencies[runtimePackage.name],runtimePackage.version)
  assert.equal(sdkPackage.version,runtimePackage.version)
  const runtimeManifest=JSON.parse(readFileSync(join(runtime,'package-assets.json'),'utf8'))
  const packageManifestSHA256=nativeExampleHash(readFileSync(join(runtime,'package-assets.json')))
  const manifest=JSON.parse(readFileSync(join(deployment,'deployment-manifest.json'),'utf8'))
  verifyDeploymentAssets(deployment,manifest,{packageManifestSHA256,expectedFiles:manifest.files})
  const deployed=new Map(manifest.files.map(file=>[file.path,file]))
  for(const file of runtimeManifest.files.filter(file=>file.path.startsWith('runtime/')||file.path.startsWith('preview-host/'))){
    assert.deepEqual(deployed.get(file.path),file,'Native acceptance deployment differs from installed runtime: '+file.path)
  }
  const pinned=readPinnedNativeExamples(root)
  const runners=Object.fromEntries(['scripts/native-release-acceptance.mjs','scripts/sdk-browser-assets.mjs',
    'scripts/native-example-sources.mjs','scripts/acceptance-failures.mjs','scripts/native-stream-observation.mjs',
    'scripts/native-install-stage-observation.mjs','scripts/native-install-filesystem-observation.mjs','scripts/safari-install-stage-trace.mjs',
    'scripts/native-owner-startup-observation.mjs','scripts/native-fetch-consumption-observation.mjs','scripts/native-worker-io-observation.mjs',
    'scripts/native-preview-interaction-observation.mjs','scripts/native-preview-click-listener-observation.mjs',
    'tests/native-owner-sdk.test.mjs'].map(path=>
    [path,nativeExampleHash(readFileSync(join(root,path)))]))
  return {sdkManifestSHA256:nativeExampleHash(readFileSync(join(sdk,'package-assets.json'))),
    runtimeManifestSHA256:packageManifestSHA256,
    deploymentManifestSHA256:nativeExampleHash(readFileSync(join(deployment,'deployment-manifest.json'))),
    examplesManifestSHA256:pinned.manifestSHA256,examplesRevision:pinned.manifest.revision,
    version:sdkPackage.version,examples:pinned.examples.size,runners}
}

export function runNativeReleaseAcceptance({root=process.cwd(),sdk,deployment,env=process.env,run=execFileSync}){
  root=resolve(root);sdk=resolve(sdk);deployment=resolve(deployment)
  const identity=nativeReleaseAcceptanceIdentity(root,sdk,deployment)
  const results=[]
  for(const entry of nativeReleaseAcceptancePlan({root,sdk,deployment,env})){
    run(entry.command,entry.args,entry.options)
    assert.deepEqual(nativeReleaseAcceptanceIdentity(root,sdk,deployment),identity,'Native acceptance inputs changed during the browser run')
    results.push({browser:entry.browser,passed:true,...identity})
    console.log('NATIVE_RELEASE_ACCEPTANCE '+JSON.stringify(results.at(-1)))
  }
  return results
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,4,'Usage: node scripts/native-release-acceptance.mjs INSTALLED_SDK PREPARED_DEPLOYMENT')
  runNativeReleaseAcceptance({sdk:process.argv[2],deployment:process.argv[3]})
}
