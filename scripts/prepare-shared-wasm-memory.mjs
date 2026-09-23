import {readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fixtureAssembler} from './fixture-toolchains.mjs'
const {assembler,command,prefix}=fixtureAssembler()
const sha=data=>createHash('sha256').update(data).digest('hex'),fixtures=[]
for(const name of ['memory','memory-unshared']){
  const source=`fixtures/shared-wasm/${name}.wat`,target=`fixtures/shared-wasm/${name}.wasm`
  const run=spawnSync(command,[...prefix,'--enable-threads',source,'-o',target],{encoding:'utf8',timeout:30000})
  if(run.status!==0)throw Error(run.stderr+'\n'+run.stdout+'\n'+(run.error??''))
  const bytes=readFileSync(target)
  if(!WebAssembly.validate(bytes))throw Error('Native WebAssembly rejected '+name)
  fixtures.push({name,sourceSHA256:sha(readFileSync(source)),wasmSHA256:sha(bytes),bytes:bytes.length})
}
writeFileSync('fixtures/shared-wasm/memory-manifest.json',JSON.stringify({assemblerSHA256:sha(readFileSync(assembler)),fixtures},null,2)+'\n')
console.log('Prepared shared WASM memory fixtures')
