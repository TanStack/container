import {test,expect} from 'vitest'
import {readFileSync,mkdtempSync,mkdirSync,copyFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {applyWasmMemoryPolicy} from '../src/compiler/wasm-memory-policy'
import {build as bundleAdapter} from 'esbuild'

test('stock Node wrapper builds virtual TypeScript files and calls plugins in its caller',async()=>{
  const root=mkdtempSync(join(tmpdir(),'capped-node-service-'))
  let esbuild:any
  try{
    mkdirSync(join(root,'lib'));mkdirSync(join(root,'bin'))
    const original=readFileSync('node_modules/esbuild-wasm/esbuild.wasm')
    const prepared=applyWasmMemoryPolicy(original,1024)
    for(const file of ['lib/main.js','wasm_exec.js'])copyFileSync('node_modules/esbuild-wasm/'+file,join(root,file))
    copyFileSync('tests/fixtures/capped-node-service-launcher.cjs',join(root,'bin/esbuild'))
    copyFileSync('tests/fixtures/capped-node-service.worker.cjs',join(root,'worker.cjs'))
    await bundleAdapter({entryPoints:['tests/fixtures/compiler-workspace-adapter.ts'],outfile:join(root,'adapter.cjs'),bundle:true,platform:'node',format:'cjs'})
    writeFileSync(join(root,'esbuild.wasm'),prepared.bytes)
    writeFileSync(join(root,'workspace.json'),JSON.stringify({'/workspace/entry.ts':'import { answer } from "./answer"; import { label } from "virtual:label"; console.log(label, answer);','/workspace/answer.ts':'export const answer: number = 42;'}))
    const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
    const provenance={version:'0.28.2',wrapper:hash(readFileSync(join(root,'lib/main.js'))),runtime:hash(readFileSync(join(root,'wasm_exec.js'))),adapter:hash(readFileSync(join(root,'adapter.cjs'))),originalCompiler:hash(original),preparedCompiler:hash(prepared.bytes),maxPages:prepared.declaredMaxPages}
    writeFileSync(join(root,'provenance.json'),JSON.stringify(provenance,null,2)+'\n')
    expect(provenance.wrapper).toBe(hash(readFileSync('node_modules/esbuild-wasm/lib/main.js')))
    expect(provenance.preparedCompiler).not.toBe(provenance.originalCompiler)
    esbuild=createRequire(import.meta.url)(join(root,'lib/main.js'))
    const callbacks:string[]=[]
    let label='answer'
    const options={absWorkingDir:'/workspace',entryPoints:['entry.ts'],bundle:true,write:true,outfile:'/workspace/out/bundle.js',format:'esm',plugins:[{name:'caller-plugin',setup(build:any){build.onResolve({filter:/^virtual:/},(args:any)=>{callbacks.push('resolve:'+args.path);return {path:args.path,namespace:'caller'}});build.onLoad({filter:/.*/,namespace:'caller'},()=>{callbacks.push('load');return {contents:'export const label: string = '+JSON.stringify(label)+';',loader:'ts'}})}}]}
    const result=await esbuild.build(options)
    expect(esbuild.version).toBe('0.28.2')
    expect(callbacks).toEqual(['resolve:virtual:label','load'])
    expect(result.outputFiles).toBeUndefined()
    const evidence=JSON.parse(readFileSync(join(root,'workspace-evidence.json'),'utf8'))
    expect(evidence.files['/workspace/out/bundle.js']).toContain('answer = 42')
    expect(evidence.files['/workspace/out/bundle.js']).toContain('label = "answer"')
    expect(result.warnings).toEqual([])
    // Keep the same service alive and replace its output using changed caller
    // plugin data. This catches stale plugin callbacks and output truncation.
    label='ok'
    const second=await esbuild.build(options)
    const updated=JSON.parse(readFileSync(join(root,'workspace-evidence.json'),'utf8'))
    expect(updated.closed).toBe(false)
    expect(evidence.servicePid).toBeGreaterThan(0)
    expect(updated.servicePid).toBe(evidence.servicePid)
    expect(updated.files['/workspace/out/bundle.js']).toContain('label = "ok"')
    expect(updated.files['/workspace/out/bundle.js']).not.toContain('label = "answer"')
    expect(callbacks).toEqual(['resolve:virtual:label','load','resolve:virtual:label','load'])
    expect(second.warnings).toEqual([])
    console.log('Capped Node service evidence',root,JSON.stringify(provenance))
  }finally{
    esbuild?.stop()
    if(esbuild)await expect.poll(()=>{
      try{return JSON.parse(readFileSync(join(root,'workspace-evidence.json'),'utf8'))}catch{return null}
    },{timeout:2000}).toMatchObject({closed:true,descriptors:0,sessions:0})
    // Caller-side Node filesystem temporary-file transforms are not covered.
  }
},15000)
