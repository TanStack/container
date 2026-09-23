import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,existsSync,mkdirSync,writeFileSync,appendFileSync,cpSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,dirname} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {assembleCompilerAssets,requiredDependencies} from '../src/sdk/compiler-assets.mjs'
import {buildRolldownAdapter} from '../scripts/build-rolldown-parser.mjs'
const compilerArtifact=JSON.parse(readFileSync('src/compiler/esbuild-artifact.json'))
const parserInputs=JSON.parse(readFileSync('src/compiler/rolldown-parser-inputs.json'))
const resolveFrom=pathToFileURL(resolve('tests/fixtures/rolldown-native-probe/package.json'))
const next=()=>join(mkdtempSync(join(tmpdir(),'compiler-assets-')),'assets')
test('assembles exact installed compiler and parser assets without changing upstream bytes',async()=>{
  const destination=next(),wasm=readFileSync('tests/fixtures/rolldown-native-probe/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasm32-wasi.wasm')
  const adapterDirectory=join(mkdtempSync(join(tmpdir(),'compiler-adapter-')),'adapter')
  await buildRolldownAdapter(adapterDirectory)
  const result=await assembleCompilerAssets(destination,{resolveFrom,compilerArtifact,parserInputs,parserEntry:join(adapterDirectory,'worker.mjs')})
  assert.equal(result.parser.version,requiredDependencies['@rolldown/binding-wasm32-wasi'])
  assert.deepEqual(readFileSync(join(destination,'rolldown-parser/parser.wasm')),wasm)
  assert.deepEqual(readFileSync('tests/fixtures/rolldown-native-probe/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasm32-wasi.wasm'),wasm)
  assert.deepEqual(readFileSync(join(destination,'compiler/esbuild.wasm')),readFileSync('node_modules/esbuild-wasm/esbuild.wasm'))
  const notices=JSON.parse(readFileSync(join(destination,'rolldown-parser/notices/inventory.json')))
  assert.equal(notices.complete,false)
  assert.ok(notices.packages.some(pkg=>pkg.name==='@emnapi/core'&&pkg.files.length))
  await assert.rejects(assembleCompilerAssets(destination,{resolveFrom,compilerArtifact}),/already exists/)
})
test('rejects version and content mismatch before creating output',async()=>{
  for(const artifact of [{...compilerArtifact,version:'0.0.0'},{...compilerArtifact,hashes:{...compilerArtifact.hashes,'esbuild.wasm':'bad'}}]){
    const destination=next()
    await assert.rejects(assembleCompilerAssets(destination,{resolveFrom,compilerArtifact:artifact}),/version|hash mismatch/)
    assert.equal(existsSync(destination),false)
  }
  const destination=next()
  await assert.rejects(assembleCompilerAssets(destination,{resolveFrom,compilerArtifact,parserEntry:resolve('src/compiler/rolldown-parser.worker.mjs'),parserInputs:{...parserInputs,version:'0.0.0'}}),/binding version/)
  assert.equal(existsSync(destination),false)
  const badHash=next()
  await assert.rejects(assembleCompilerAssets(badHash,{resolveFrom,compilerArtifact,parserEntry:resolve('src/compiler/rolldown-parser.worker.mjs'),parserInputs:{...parserInputs,inputs:{...parserInputs.inputs,'@napi-rs/wasm-runtime/runtime.js':'bad'}}}),/hash mismatch/)
  assert.equal(existsSync(badHash),false)
})

test('recognizes only the explicit adapter inside an installed SDK package',async()=>{
  const root=mkdtempSync(join(tmpdir(),'installed-compiler-adapter-'))
  const pkg=join(root,'node_modules/@tanstack/browser-sandbox-runtime-experimental')
  mkdirSync(pkg,{recursive:true})
  writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@tanstack/browser-sandbox-runtime-experimental',version:'0.0.0',type:'module'}))
  const adapter=join(pkg,'adapter')
  await buildRolldownAdapter(adapter)
  const parserEntry=join(adapter,'worker.mjs')
  const result=await assembleCompilerAssets(next(),{resolveFrom,compilerArtifact,parserInputs,parserEntry})
  assert.match(result.parser.adapterSHA256,/^[a-f0-9]{64}$/)
  assert.ok(Object.keys(result.parser.sources).every(path=>!path.startsWith('@tanstack/')))
  writeFileSync(join(adapter,'unexpected.mjs'),'globalThis.unexpectedAdapterDependency = true\n')
  appendFileSync(parserEntry,'\nimport "./unexpected.mjs"\n')
  await assert.rejects(assembleCompilerAssets(next(),{resolveFrom,compilerArtifact,parserInputs,parserEntry}),/Unsupported bundled dependency version: @tanstack\/browser-sandbox-runtime-experimental/)
})

test('uses pinned direct dependencies when a compiler package has a conflicting nested copy',async()=>{
  const root=mkdtempSync(join(tmpdir(),'compiler-nested-dependencies-'))
  const require=createRequire(resolveFrom)
  for(const name of Object.keys(requiredDependencies)){
    let source=dirname(require.resolve(name))
    while(!existsSync(join(source,'package.json'))||JSON.parse(readFileSync(join(source,'package.json'))).name!==name)source=dirname(source)
    const destination=join(root,'node_modules',name)
    mkdirSync(dirname(destination),{recursive:true})
    if(name==='@napi-rs/wasm-runtime')cpSync(source,destination,{recursive:true})
    else symlinkSync(source,destination,'dir')
  }
  const nested=join(root,'node_modules/@napi-rs/wasm-runtime/node_modules/@tybys/wasm-util')
  mkdirSync(nested,{recursive:true})
  writeFileSync(join(nested,'package.json'),JSON.stringify({name:'@tybys/wasm-util',version:'0.10.3',main:'index.js'}))
  writeFileSync(join(nested,'index.js'),'throw new Error("nested compiler dependency must not be bundled")')
  const adapter=join(root,'adapter');await buildRolldownAdapter(adapter)
  const options={compilerArtifact,parserInputs,parserEntry:join(adapter,'worker.mjs')}
  const baseline=await assembleCompilerAssets(next(),{...options,resolveFrom})
  const actual=await assembleCompilerAssets(next(),{...options,resolveFrom:pathToFileURL(join(root,'package.json'))})
  assert.deepEqual(actual.parser.sources,baseline.parser.sources)
  assert.ok(Object.keys(actual.parser.sources).some(path=>path.startsWith('@tybys/wasm-util/')))
  assert.equal(JSON.parse(readFileSync(join(nested,'package.json'))).version,'0.10.3')
})

test('compiler assets are byte-identical across distinct consumer installation directories',async()=>{
  const require=createRequire(resolveFrom),results=[]
  const adapter=join(mkdtempSync(join(tmpdir(),'compiler-repro-adapter-')),'adapter')
  await buildRolldownAdapter(adapter)
  const adapterBytes=readFileSync(join(adapter,'worker.mjs'))
  for(let index=0;index<2;index++){
    const root=mkdtempSync(join(tmpdir(),'compiler-repro-consumer-'))
    for(const name of Object.keys(requiredDependencies)){
      let source=dirname(require.resolve(name))
      while(!existsSync(join(source,'package.json'))||JSON.parse(readFileSync(join(source,'package.json'))).name!==name)source=dirname(source)
      const destination=join(root,'node_modules',name)
      mkdirSync(dirname(destination),{recursive:true})
      // The bundler executable is not an emitted source input. Keep its native
      // platform dependency intact while relocating every bundled package.
      if(name==='esbuild')symlinkSync(source,destination,'dir')
      else cpSync(source,destination,{recursive:true,filter:path=>path===source||!path.slice(source.length+1).split('/').includes('node_modules')})
    }
    const localAdapter=join(root,'adapter');mkdirSync(localAdapter)
    const parserEntry=join(localAdapter,'worker.mjs')
    writeFileSync(parserEntry,Buffer.concat([Buffer.from('/*! retained adapter license */\n'),adapterBytes]))
    const result=await assembleCompilerAssets(next(),{resolveFrom:pathToFileURL(join(root,'package.json')),compilerArtifact,parserInputs,parserEntry})
    for(const name of ['worker.js','pthread.js'])assert.ok(!readFileSync(join(result.directory,'rolldown-parser',name),'utf8').includes(root))
    assert.match(readFileSync(join(result.directory,'rolldown-parser/worker.js'),'utf8'),/retained adapter license/)
    results.push(result)
  }
  assert.deepEqual(results[0].parser,results[1].parser)
  for(const name of ['worker.js','pthread.js','parser.wasm','artifact.json','notices/inventory.json'])assert.deepEqual(readFileSync(join(results[0].directory,'rolldown-parser',name)),readFileSync(join(results[1].directory,'rolldown-parser',name)),name)
})
