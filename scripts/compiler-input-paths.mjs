import {resolve} from 'node:path'

/** Browser-disabled modules are synthetic empty inputs, not installed files. */
export function compilerInputPaths(root,metafile){
  return Object.entries(metafile?.inputs??{}).flatMap(([name,input])=>{
    if(name.startsWith('(disabled):')){
      if(input.bytes!==0)throw Error('Disabled compiler input contains bytes: '+name)
      return []
    }
    return [resolve(root,name)]
  })
}
