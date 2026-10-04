import {execFileSync} from 'node:child_process'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'

export function releaseRuntimeBuildPlan(root=process.cwd()){
  root=resolve(root)
  return [
    ['scripts/build-mvdan-shell.mjs',join(root,'.toolchains/go-sdk')],
    ['scripts/build-native-runtime-catalog.mjs'],
  ]
}

export function buildReleaseRuntime({root=process.cwd(),run=execFileSync}={}){
  for(const args of releaseRuntimeBuildPlan(root))run(process.execPath,args,{cwd:resolve(root),stdio:'inherit'})
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))buildReleaseRuntime()
