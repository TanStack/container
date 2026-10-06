import {readFile} from 'node:fs/promises'
import {dirname,join,basename} from 'node:path'
import {transform} from 'esbuild'

const entries=new Map([
  ['@emnapi/core@1.11.1','emnapi-core.esm-bundler.js'],
  ['@emnapi/core@2.0.0-alpha.5','emnapi-core.js'],
  ['@emnapi/wasi-threads@1.2.2','wasi-threads.esm-bundler.js'],
  ['@emnapi/wasi-threads@2.1.0','wasi-threads.js'],
])

export async function compilerBrowserHostSource(source,{name,version,file}){
  if(!['@emnapi/core','@emnapi/wasi-threads'].includes(name))return
  if(entries.get(name+'@'+version)!==file)throw Error('Unverified compiler host entry: '+name+'@'+version+'/'+file)
  const classifier=/\b(?:const|var)\s+ENVIRONMENT_IS_NODE\s*=\s*typeof process\s*===\s*'object'\s*&&\s*process\s*!==\s*null\s*&&\s*typeof process\.versions\s*===\s*'object'\s*&&\s*process\.versions\s*!==\s*null\s*&&\s*typeof process\.versions\.node\s*===\s*'string'\s*;/g
  if([...source.matchAll(classifier)].length!==1)throw Error('Compiler physical host classifier changed: '+name+'@'+version)
  // These modules run on a browser host, not inside the guest Node runtime.
  // Select their browser protocol at build time. Never mutate or hide the
  // shared process facade during an asynchronous compiler import.
  return (await transform(source,{loader:'js',format:'esm',target:'es2022',legalComments:'inline',
    define:{'process.versions.node':'undefined'},minifySyntax:true})).code
}

export function compilerBrowserHostPlugin(onTarget=()=>{}){
  return {name:'compiler-browser-host-target',setup(bundler){
    bundler.onLoad({filter:/[/\\]dist[/\\](?:emnapi-core|wasi-threads)(?:\.esm-bundler)?\.js$/},async args=>{
      const manifest=JSON.parse(await readFile(join(dirname(args.path),'..','package.json'),'utf8'))
      const source=await readFile(args.path,'utf8')
      const contents=await compilerBrowserHostSource(source,{...manifest,file:basename(args.path)})
      if(contents===undefined)return
      onTarget({name:manifest.name,version:manifest.version,file:basename(args.path),host:'browser'})
      return {contents,loader:'js',resolveDir:dirname(args.path)}
    })
  }}
}
