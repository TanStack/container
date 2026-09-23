import {readFileSync,readdirSync,mkdirSync,writeFileSync,copyFileSync,mkdtempSync,cpSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {resolveWasm3Source,resolveEmscripten} from './fixture-toolchains.mjs'

const positional=process.argv.slice(2).filter(arg=>!arg.startsWith('--'))
const ubsan=process.argv.includes('--ubsan')
const source=resolveWasm3Source({source:positional[0]})
const emcc=resolveEmscripten({compiler:positional[1]})
const revision='5fe766c933c7595d728d6172bb1a197607d85b4e'
const run=(command,args,timeout=120000)=>{
  const result=spawnSync(command,args,{encoding:'utf8',timeout,maxBuffer:16*1024*1024})
  if(result.status!==0)throw Error(command+' failed\n'+result.stdout+'\n'+result.stderr+'\n'+(result.error??''))
  return result.stdout
}
if(run('git',['-C',source,'rev-parse','HEAD']).trim()!==revision)throw Error('Unexpected Wasm3 revision')
if(run('git',['-C',source,'status','--porcelain']).trim())throw Error('Wasm3 source is not clean')
if(!run(emcc,['--version']).includes('5.0.1'))throw Error('Expected Emscripten 5.0.1')
const directory=mkdtempSync(join(tmpdir(),'web-container-wasm-build-'))
cpSync(join(source,'source'),join(directory,'source'),{recursive:true})
const patch=resolve('patches/wasm3-frame-budget.patch')
const validationPatch=resolve('patches/wasm3-export-validation.patch')
for(const file of [patch,validationPatch]) {
  run('patch',['--dry-run','-p1','-d',directory,'-i',file])
  run('patch',['-p1','-d',directory,'-i',file])
}
const cSources=readdirSync(join(directory,'source')).filter(name=>name.endsWith('.c')).sort().map(name=>join(directory,'source',name))
const nativeCLI=join(directory,'wasm3')
console.log('Building trusted fixture assembler host')
// WABT is a trusted build tool, so preserve its upstream frame policy.
const upstreamSources=readdirSync(join(source,'source')).filter(name=>name.endsWith('.c')).sort().map(name=>join(source,'source',name))
run('cc',['-O2','-I'+join(source,'source'),'-Dd_m3HasWASI',...upstreamSources,join(source,'platforms/app/main.c'),'-lm','-o',nativeCLI])
const outputRelative='public/wasm-interpreter-probe'+(ubsan?'-ubsan':'')
const output=resolve(outputRelative)
mkdirSync(output,{recursive:true})
const fixtureFiles={}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
for(const name of readdirSync('fixtures/wasm-interpreter').filter(name=>name.endsWith('.wat')).sort()){
  const target=name.replace(/\.wat$/,'.wasm')
  // The assembler's WASI preopen maps the current directory, not the host root.
  run(nativeCLI,['--stack-size','1048576',join(source,'test/wasi/wabt/wat2wasm.wasm'),'--enable-all','fixtures/wasm-interpreter/'+name,'-o',outputRelative+'/'+target])
  fixtureFiles[target]={sha256:sha(readFileSync(join(output,target))),watSHA256:sha(readFileSync('fixtures/wasm-interpreter/'+name))}
}
// Extract the actual embedded module through a capture-only constructor, not a reimplementation.
const md4Source=readFileSync('fixtures/workloads/node_modules/webpack/lib/util/hash/md4.js','utf8')
const {runInNewContext}=await import('node:vm')
let md4
runInNewContext(md4Source,{
  Buffer,module:{exports:{}},require:()=>()=>{},
  WebAssembly:{Module:class{constructor(bytes){md4=Uint8Array.from(bytes)}}},
},{timeout:1000})
if(!md4||!WebAssembly.validate(md4))throw Error('Could not extract Webpack MD4 module')
writeFileSync(join(output,'webpack-md4.wasm'),md4)
fixtureFiles['webpack-md4.wasm']={sha256:sha(md4),packageSourceSHA256:sha(md4Source),bytes:md4.length}
const flags=['-Oz','-mtail-call','-Dd_m3MaxLinearMemoryPages=128','-Dd_m3MaxNativeStack=131072','-Dd_m3HasExceptionHandling=0',
  '-sMODULARIZE=1','-sEXPORT_ES6=1','-sEXPORT_NAME=createWasm3Probe','-sENVIRONMENT=web,worker,node',
  '-sALLOW_MEMORY_GROWTH=1','-sINITIAL_MEMORY=16777216','-sMAXIMUM_MEMORY=67108864','-sSTACK_SIZE=524288','-sABORTING_MALLOC=0','-sASSERTIONS=1',
  '-sEXPORTED_FUNCTIONS='+JSON.stringify(['_malloc','_free','_probe_open','_probe_close','_probe_call','_probe_answer','_probe_error','_probe_budget','_probe_used','_probe_frames','_probe_memory','_probe_memory_size']),
  '-sEXPORTED_RUNTIME_METHODS='+JSON.stringify(['ccall','UTF8ToString','HEAPU8'])]
console.log('Building browser interpreter')
if(ubsan)flags.push('-fsanitize=undefined','-fno-sanitize-recover=all')
run(emcc,[...flags,'-I'+join(directory,'source'),resolve('fixtures/wasm-interpreter/probe.c'),...cSources,'-o',join(output,'engine.mjs')])
copyFileSync(join(source,'LICENSE'),join(output,'LICENSE'))
const manifest={revision,sdk:'5.0.1',ubsan,adapterSHA256:sha(readFileSync('fixtures/wasm-interpreter/probe.c')),flags,
  framePatchSHA256:sha(readFileSync(patch)),activeFrameLimit:256,
  validationPatchSHA256:sha(readFileSync(validationPatch)),
  wasmSHA256:sha(readFileSync(join(output,'engine.wasm'))),wasmBytes:readFileSync(join(output,'engine.wasm')).length,
  interpreterHeapMaxBytes:64*1024*1024,linearMemoryMaxBytes:8*1024*1024,fixtureFiles,
  scope:'Standalone interpreter probe, not integrated guest WebAssembly',nativeCLI}
writeFileSync(join(output,'build.json'),JSON.stringify(manifest,null,2)+'\n')
console.log(JSON.stringify({output,wasmBytes:manifest.wasmBytes,wasmSHA256:manifest.wasmSHA256,nativeCLI}))
