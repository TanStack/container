import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fixtureAssembler} from './fixture-toolchains.mjs'
const {assembler,command,prefix,revision}=fixtureAssembler()
mkdirSync('public/guest-wasm',{recursive:true})
const sha=data=>createHash('sha256').update(data).digest('hex'),files={}
for(const name of readdirSync('fixtures/guest-wasm').filter(name=>name.endsWith('.wat'))){
  const source='fixtures/guest-wasm/'+name,target='public/guest-wasm/'+name.replace(/\.wat$/,'.wasm')
  // --enable-all emits compact imports that the Node reference does not accept.
  // These fixtures need only the assembler's default core features.
  const flags=name==='memory-multi.wat'?['--enable-multi-memory']:['table-import.wat','tail-dispatch.wat'].includes(name)?['--enable-tail-call']:[]
  const run=spawnSync(command,[...prefix,...flags,source,'-o',target],{encoding:'utf8',timeout:30000})
  if(run.status!==0)throw Error(run.stderr+'\n'+run.stdout+'\n'+(run.error??''))
  const bytes=readFileSync(target)
  if(!WebAssembly.validate(bytes))throw Error('Native WebAssembly rejected '+name)
  files[name]={sourceSHA256:sha(readFileSync(source)),wasmSHA256:sha(bytes),bytes:bytes.length}
}
writeFileSync('public/guest-wasm/manifest.json',JSON.stringify({revision,assemblerSHA256:sha(readFileSync(assembler)),files},null,2)+'\n')
console.log('Prepared',Object.keys(files).length,'guest WASM fixtures')
