import {readFileSync} from 'node:fs'
import {dirname,join,relative} from 'node:path'
/** Owned transport fixture only. Not a replacement for Vite's resolver callback. */
export function resolveSubpathImports(id,importer,isRequire,scan){
  if(!importer||!id.startsWith('#'))return
  let directory=dirname(importer)
  for(;;){
    let source
    try{source=readFileSync(join(directory,'package.json'),'utf8')}catch(error){if(error.code!=='ENOENT')throw error}
    if(source!==undefined){
      const target=JSON.parse(source).imports?.[id]
      if(target===undefined)return
      if(typeof target!=='string'||!target.startsWith('./')||id.includes('*'))throw Error('Unsupported owned fixture import mapping')
      const path=relative(dirname(importer),join(directory,target))
      return path.startsWith('.')?path:'./'+path
    }
    const parent=dirname(directory);if(parent===directory)return;directory=parent
  }
}
