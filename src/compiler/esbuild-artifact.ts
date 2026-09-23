import type {WorkspaceFiles} from '../sandbox/files'
import {applyWasmMemoryPolicy} from './wasm-memory-policy'
import pinnedArtifact from './esbuild-artifact.json'

// Explicit supported artifact, not a package-name or version-only substitution.
export const esbuildArtifact = Object.freeze({
  version:pinnedArtifact.version,
  hashes:Object.freeze(pinnedArtifact.hashes),
})

async function digest(bytes:Uint8Array){
  const hash=await crypto.subtle.digest('SHA-256',bytes.slice().buffer)
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('')
}

/** Preparation only. The caller must opt into a separate compiler execution policy.
 * Capture all source bytes before awaiting hashes so preparation uses one snapshot.
 * No installed files are rewritten, and no workspace JavaScript is evaluated here.
 */
export async function prepareEsbuildArtifact(files:WorkspaceFiles,entry:string,maxPages:number){
  const resolved=files.realpathSync(entry)
  if(!resolved.endsWith('/bin/esbuild'))throw Error('Unsupported compiler entry')
  const root=resolved.slice(0,-'/bin/esbuild'.length)
  const entries=Object.entries(esbuildArtifact.hashes)
  const captured=entries.map(([name,expected])=>{
    const path=root+'/'+name
    const size=files.statSync(path).size
    const maximum=name==='esbuild.wasm'?64*1024*1024:1024*1024
    if(size>maximum)throw Error('Unsupported compiler artifact size: '+name)
    return {name,expected,bytes:files.readFileSync(path)}
  })
  for(const file of captured){
    if(await digest(file.bytes)!==file.expected)throw Error('Unsupported compiler artifact: '+file.name)
  }
  const original=captured.find(file=>file.name==='esbuild.wasm')!.bytes
  const prepared=applyWasmMemoryPolicy(original,maxPages)
  return {
    entry:resolved,version:esbuildArtifact.version,bytes:prepared.bytes,
    originalHash:esbuildArtifact.hashes['esbuild.wasm'],
    preparedHash:await digest(prepared.bytes),
    runtimeHash:esbuildArtifact.hashes['wasm_exec.js'],
    minPages:prepared.minPages,maxPages:prepared.declaredMaxPages,
  }
}
