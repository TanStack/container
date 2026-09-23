import {test,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {WorkspaceFiles} from '../src/sandbox/files'
import {esbuildArtifact,prepareEsbuildArtifact} from '../src/compiler/esbuild-artifact'

function workspace(){
  return new WorkspaceFiles(Object.fromEntries(Object.keys(esbuildArtifact.hashes).map(name=>[
    '/project/node_modules/esbuild-wasm/'+name,
    new Uint8Array(readFileSync('node_modules/esbuild-wasm/'+name)),
  ])),128*1024*1024)
}
const entry='/project/node_modules/esbuild-wasm/bin/esbuild'

test('prepares exact installed esbuild bytes without rewriting the workspace',async()=>{
  const files=workspace()
  try{
    const original=files.readFileSync('/project/node_modules/esbuild-wasm/esbuild.wasm')
    const result=await prepareEsbuildArtifact(files,entry,1024)
    expect(result).toMatchObject({entry,version:'0.28.2',minPages:95,maxPages:1024,
      preparedHash:'42700ee2eaf6cb18c667286e8b748b220bfdc58693966bc9a9a9e7d353fb66d9'})
    expect(WebAssembly.validate(result.bytes)).toBe(true)
    // Native byte comparison avoids recursively walking millions of numeric keys.
    expect(Buffer.compare(files.readFileSync('/project/node_modules/esbuild-wasm/esbuild.wasm'),original)).toBe(0)
  }finally{files.close()}
})

test('does not select a modified launcher just because its package path matches',async()=>{
  const files=workspace()
  try{
    files.writeFileSync(entry,new TextEncoder().encode('console.log("custom compiler")'))
    await expect(prepareEsbuildArtifact(files,entry,1024)).rejects.toThrow('Unsupported compiler artifact: bin/esbuild')
  }finally{files.close()}
})

test('preparation captures one file snapshot before asynchronous hashing',async()=>{
  const files=workspace()
  try{
    const pending=prepareEsbuildArtifact(files,entry,1024)
    files.writeFileSync('/project/node_modules/esbuild-wasm/esbuild.wasm',new Uint8Array([1,2,3]))
    const result=await pending
    expect(result.preparedHash).toBe('42700ee2eaf6cb18c667286e8b748b220bfdc58693966bc9a9a9e7d353fb66d9')
    expect(files.readFileSync('/project/node_modules/esbuild-wasm/esbuild.wasm')).toEqual(new Uint8Array([1,2,3]))
  }finally{files.close()}
})
