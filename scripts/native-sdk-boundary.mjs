import {resolve,relative} from 'node:path'
export {assertNativeSDKRuntimePaths} from './native-runtime-paths.mjs'

const legacySource=/^src\/(?:sdk\/(?:index|agent-session|worker-kernel|hosted-kernel|kernel-host|runtime-profile|shell|project-command|worker-factories)\.|sandbox\/(?:kernel(?:\.|-)|process\.|compile\.|mvdan-shell(?:\.|-)|worker-factories\.)|compiler\/)/
const legacyPackage=/(?:^|\/)node_modules\/(?:\.pnpm\/[^/]*quickjs[^/]*\/node_modules\/)?(?:quickjs[^/]*|@jitl\/quickjs[^/]*)\//

/** Check loaded modules, including tree-shaken modules, not just final bundle text. */
export function assertNativeSDKModuleGraph(ids,root=process.cwd()){
  const paths=[...new Set([...ids].map(id=>id.replace(/^\0/,'').split('?')[0]).map(id=>
    id.startsWith(resolve(root)+'/')?relative(root,id).replaceAll('\\','/'):id))].sort()
  if(paths.some(path=>path.startsWith('/')||path.includes('\0')||path.split('/').includes('..')))throw Error('Native SDK module graph escapes the source tree')
  const forbidden=paths.filter(path=>legacySource.test(path)||legacyPackage.test(path))
  if(forbidden.length)throw Error('Native SDK imports legacy runtime modules: '+forbidden.join(', '))
  return paths
}
