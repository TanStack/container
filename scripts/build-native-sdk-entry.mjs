import {build} from 'vite'
import {createHash} from 'node:crypto'
import {readFileSync,realpathSync,mkdtempSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {assertNativeSDKModuleGraph} from './native-sdk-boundary.mjs'
export {assertNativeSDKModuleGraph} from './native-sdk-boundary.mjs'

/** Build the native browser API only. This is not a runtime package or release. */
export async function buildNativeSDKEntry(output,{plugins=[],filename='native.js'}={}){
  if(!['native.js','index.js'].includes(filename))throw Error('Unknown native SDK entry filename')
  const root=realpathSync(process.cwd()),out=realpathSync(output)
  let graph
  const boundary={name:'native-sdk-runtime-boundary',generateBundle(){
    graph=assertNativeSDKModuleGraph(this.getModuleIds(),root)
  }}
  await build({configFile:false,root,publicDir:false,base:'./',worker:{format:'es'},
    plugins:[...plugins,boundary],build:{outDir:out,emptyOutDir:false,target:'es2022',
      rollupOptions:{output:{chunkFileNames:'native-chunks/[name]-[hash].js'}},
      lib:{entry:resolve(root,'src/sdk/native.ts'),formats:['es'],fileName:()=> filename}}})
  if(!graph)throw Error('Native SDK module graph was not verified')
  const entry=readFileSync(join(out,filename))
  const evidence={format:1,scope:'native-browser-entry',entry:filename,
    entrySHA256:createHash('sha256').update(entry).digest('hex'),entryBytes:entry.length,
    modules:graph,legacyRuntimeModules:[],runtimeAssetsIncluded:false,releaseApproved:false}
  writeFileSync(join(out,'native-entry-graph.json'),JSON.stringify(evidence,null,2)+'\n')
  return evidence
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==2)throw Error('Usage: node scripts/build-native-sdk-entry.mjs')
  const output=mkdtempSync(join(tmpdir(),'native-sdk-entry-'))
  const evidence=await buildNativeSDKEntry(output)
  console.log(JSON.stringify({output,...evidence}))
}
