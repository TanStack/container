import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {existsSync,mkdirSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {nativeRuntimeBuildPlan,verifyNativeCompilerPackage,inspectNativeRuntimeBuild} from './native-runtime-build-plan.mjs'

export function buildNativeRuntimeCatalog({root=process.cwd(),output=join(root,'public/native-runtimes'),run=execFileSync}={}){
  root=resolve(root);output=resolve(output)
  assert.ok(!existsSync(output),'Native runtime catalog output exists; use a new directory')
  const plan=nativeRuntimeBuildPlan(root,output)
  // Check every compiler before creating output or fetching native dependencies.
  for(const item of plan){
    verifyNativeCompilerPackage(item.vitePackage,'vite',item.vite)
    verifyNativeCompilerPackage(item.rolldownPackage,'@rolldown/browser',item.rolldown)
  }
  mkdirSync(output,{recursive:true})
  const oxideBuild=join(mkdtempSync(join(tmpdir(),'container-native-catalog-oxide-')),'build')
  run(process.execPath,[join(root,'scripts/build-native-oxide.mjs'),oxideBuild],{cwd:root,stdio:'inherit',env:{...process.env}})
  for(const item of plan)run(process.execPath,[join(root,'scripts/build-native-runtime.mjs')],{
    cwd:root,stdio:'inherit',env:{...process.env,
      NATIVE_OXIDE_BUILD_ROOT:oxideBuild,
      NATIVE_VITE_PACKAGE_ROOT:item.vitePackage,NATIVE_VITE_VERSION:item.vite,
      NATIVE_ROLLDOWN_PACKAGE_ROOT:item.rolldownPackage,NATIVE_ROLLDOWN_VERSION:item.rolldown,
      NATIVE_RUNTIME_OUTPUT:item.output},
  })
  const runtimes=inspectNativeRuntimeBuild(plan)
  console.log('NATIVE_RUNTIME_CATALOG='+JSON.stringify(runtimes.map(({directory,toolchain,engineSHA256})=>({directory,toolchain,engineSHA256}))))
  return runtimes
}

export function nativeRuntimeCatalogCLIOptions(args=process.argv.slice(2),env=process.env){
  assert.ok(args.length<=1,'Usage: node scripts/build-native-runtime-catalog.mjs [NEW_OUTPUT_DIRECTORY]')
  assert.ok(!(args.length&&env.NATIVE_RUNTIME_CATALOG_OUTPUT),
    'Choose an output argument or NATIVE_RUNTIME_CATALOG_OUTPUT, not both')
  return {output:args[0]??env.NATIVE_RUNTIME_CATALOG_OUTPUT}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  buildNativeRuntimeCatalog(nativeRuntimeCatalogCLIOptions())
