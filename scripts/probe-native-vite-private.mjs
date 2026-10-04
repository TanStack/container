import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {nativeReleaseAcceptanceIdentity} from './native-release-acceptance.mjs'
import {nativeSDKCheckEnvironment} from './check-native-sdk.mjs'

export function probeNativeVitePrivate(sdk,deployment,runnerRoot,{cold=false}={}) {
  const root=fileURLToPath(new URL('..',import.meta.url))
  sdk=resolve(sdk);deployment=resolve(deployment);runnerRoot=resolve(runnerRoot)
  const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
  const paths=['tests/native-vite-private-reference.mjs','tests/native-vite-private-browser.test.mjs',
    'tests/fixtures/native-vite-private-imports.mjs','tests/fixtures/native-installed-probe-host.mjs','scripts/sdk-browser-assets.mjs']
  const identity=()=>{
    const copied=Object.fromEntries(paths.map(path=>{
      const value=hash(join(root,path));assert.equal(hash(join(runnerRoot,path)),value,'Copied runner differs: '+path)
      return [path,value]
    }))
    const require=createRequire(join(runnerRoot,'package.json'))
    const browserPackage=require('@playwright/test/package.json').version
    const vitePackage=require('vite/package.json').version,rolldownPackage=require('rolldown/package.json').version
    assert.equal(browserPackage,'1.63.0');assert.equal(vitePackage,'8.3.1');assert.equal(rolldownPackage,'1.2.11')
    return {acceptance:nativeReleaseAcceptanceIdentity(root,sdk,deployment),copied,
      browserPackage,vitePackage,rolldownPackage,lockSHA256:hash(join(runnerRoot,'package-lock.json')),
      viteManifestSHA256:hash(require.resolve('vite/package.json')),viteEntrySHA256:hash(require.resolve('vite')),
      rolldownManifestSHA256:hash(require.resolve('rolldown/package.json')),rolldownEntrySHA256:hash(require.resolve('rolldown')),
      driverSHA256:hash(fileURLToPath(import.meta.url)),node:process.version,
      sourceLocks:{npm:hash(join(root,'package-lock.json')),pnpm:hash(join(root,'pnpm-lock.yaml'))}}
  }
  const before=identity(),directory=mkdtempSync(join(tmpdir(),'native-vite-private-results-'))
  const receipt={scope:'Small real Vite private-import pipeline, not full Start startup or release acceptance.',
    identity:before,cold,rows:[],passed:false}
  const save=()=>writeFileSync(join(directory,'results.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log('Vite private-import receipt: '+join(directory,'results.json'));save()
  for(const name of ['node-reference','installed-browser']){
    const args=name==='node-reference'?[join(runnerRoot,paths[0])]:
      ['--test','--test-force-exit','--test-timeout=180000',join(runnerRoot,paths[1])]
    const started=Date.now(),child=spawnSync(process.execPath,args,{cwd:runnerRoot,encoding:'utf8',maxBuffer:4*1024*1024,timeout:200000,
      env:{...nativeSDKCheckEnvironment(),NATIVE_VITE_PRIVATE_CONTROL:'1',NATIVE_SOURCE_ROOT:root,
        NATIVE_VITE_PRIVATE_COLD:cold?'1':'0',
        NATIVE_SDK_BUNDLE_DIR:sdk,NATIVE_DEPLOYMENT_DIR:deployment}})
    const output=(child.stdout??'')+'\n'+(child.stderr??'')
    writeFileSync(join(directory,name+'.log'),output,{flag:'wx'})
    const row={name,status:child.status,signal:child.signal,elapsedMs:Date.now()-started,
      error:child.error?String(child.error):undefined,passed:false}
    row.results=output.split('\n').flatMap(line=>{try{const item=JSON.parse(line);
      return item.browser||item.kind==='native-vite-private-reference'?[item]:[]}catch{return []}})
    try{
      assert.equal(child.status,0);assert.equal(child.error,undefined)
      if(name==='node-reference')assert.equal(row.results.length,1)
      else assert.deepEqual(row.results.map(item=>item.browser),['chromium','firefox','webkit'])
      assert.ok(row.results.every(item=>item.passed===true))
      assert.deepEqual(identity(),before,'Control inputs changed');row.passed=true
    }catch(error){row.validationError=String(error)}
    receipt.rows.push(row);save()
    console.log(JSON.stringify({name,status:row.status,passed:row.passed,
      results:row.results.map(item=>{const result=item.browser?item.result?.body?.result:item.result;
        return {browser:item.browser,version:item.version,passed:item.passed,builtinMatched:result?.builtinMatched,
          resolved:result?.resolved?.length,evaluated:result?.evaluated,nestedClaims:result?.nestedClaims,
          bundleEvaluated:result?.bundleEvaluated,failures:result?.failures}})}))
    if(!row.passed)break
  }
  try{assert.deepEqual(identity(),before);receipt.inputsUnchanged=true}catch(error){receipt.identityError=String(error)}
  receipt.passed=receipt.rows.length===2&&receipt.rows.every(row=>row.passed)&&receipt.inputsUnchanged===true
  save();return {directory,result:receipt}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,5,'Usage: node scripts/probe-native-vite-private.mjs INSTALLED_SDK DEPLOYMENT PRIVATE_RUNNER')
  if(!probeNativeVitePrivate(...process.argv.slice(2),{cold:process.env.NATIVE_VITE_PRIVATE_COLD==='1'}).result.passed)process.exitCode=1
}
