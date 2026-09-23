import type {WorkspaceFiles} from '../sandbox/files'
import pinned from './rolldown-binding-artifact.json'

export const rolldownBindingArtifact=Object.freeze({version:pinned.version,entry:pinned.entry,hashes:Object.freeze(pinned.hashes)})

/** Select captured binding source only. The caller must compile this captured
 * source, or revalidate after changes, before adapting its guest exports.
 * Does not opt into a backend, modify files, or execute workspace code.
 */
export async function prepareRolldownBindingArtifact(files:WorkspaceFiles,entry:string){
  const resolved=files.realpathSync(entry)
  const suffix='/'+pinned.entry
  if(!resolved.endsWith(suffix))throw Error('Unsupported Rolldown binding entry')
  const root=resolved.slice(0,-suffix.length)
  const captured=Object.entries(pinned.hashes).map(([name,expected])=>{
    const path=root+'/'+name
    if(files.statSync(path).size>1024*1024)throw Error('Unsupported Rolldown binding size: '+name)
    return {name,expected,bytes:files.readFileSync(path).slice()}
  })
  for(const item of captured){
    const digest=await crypto.subtle.digest('SHA-256',item.bytes.buffer)
    const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
    if(hash!==item.expected)throw Error('Unsupported Rolldown binding artifact: '+item.name)
  }
  return Object.freeze({entry:resolved,version:pinned.version,source:new TextDecoder().decode(captured.find(item=>item.name===pinned.entry)!.bytes),sourceSHA256:pinned.hashes['rolldown-binding.wasi.cjs']})
}
