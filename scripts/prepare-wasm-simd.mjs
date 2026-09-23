import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {deepStrictEqual} from 'node:assert'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {simdFixtures} from './wasm-simd-fixtures.mjs'
import {fixtureAssembler} from './fixture-toolchains.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const {sha256:assemblerSHA256,command,prefix}=fixtureAssembler()
const directory=mkdtempSync(join(tmpdir(),'simd-fixture-build-'))
for(const fixture of [...simdFixtures,{name:'js-boundary'}]){
  const source=readFileSync('fixtures/wasm-simd/'+fixture.name+'.wat')
  writeFileSync(join(directory,'input.wat'),source)
  // Unique output names prevent a failed assembly from reusing stale bytes.
  const output=fixture.name+'.wasm'
  const child=spawnSync(command,[...prefix,'input.wat','-o',output],{cwd:directory,encoding:'utf8',timeout:30000})
  if(child.status!==0)throw Error(child.stderr+'\n'+child.stdout+'\n'+(child.error??''))
  const bytes=readFileSync(join(directory,output))
  if(!WebAssembly.validate(bytes))throw Error('Native WebAssembly rejected '+fixture.name)
  if(fixture.run){
    const native=fixture.run(WebAssembly,bytes)
    deepStrictEqual(native,fixture.expected)
    const manifest={scope:'Native reference fixture. Guest parity is tested separately.',node:process.version,assemblerSHA256,sourceSHA256:hash(source),wasmSHA256:hash(bytes),bytes:bytes.length,native}
    writeFileSync('fixtures/wasm-simd/'+fixture.manifest+'.json',JSON.stringify(manifest,null,2)+'\n')
  }
  writeFileSync('fixtures/wasm-simd/'+fixture.name+'.wasm',bytes)
  console.log('Prepared '+fixture.name+' ('+bytes.length+' bytes)')
}
