import createNodeInspection from '../src/compiler/node-inspection.cjs'
import buffer from 'buffer/'
import path from '../src/compiler/vendor/node24/path.cjs'

// Only the standalone native probe uses this module. Production will provide
// these dependencies from its guest module loader, not this fixture inventory.
export function initialize(binding){
  const process={cwd:()=>'/',platform:'browser'}
  const url={URL:globalThis.URL,pathToFileURL(value){
    if(typeof value!=='string')throw Object.assign(new TypeError('Expected a path string'),{code:'ERR_INVALID_ARG_TYPE'})
    let absolute=path.resolve(value)
    if(value.endsWith('/')&&!absolute.endsWith('/'))absolute+='/'
    const result=new URL('file:///')
    result.pathname=absolute.replaceAll('%','%25').replaceAll('\\','%5C').replaceAll('#','%23').replaceAll('?','%3F').replaceAll('\n','%0A').replaceAll('\r','%0D').replaceAll('\t','%09')
    return result
  }}
  return createNodeInspection(binding,{process,isBuiltin:name=>['util','buffer','url','path'].includes(name.replace(/^node:/,'')),load(name){
    if(name==='node:buffer')return buffer
    if(name==='node:url')return url
    throw Error('Unavailable formatter fixture dependency: '+name)
  }})
}
