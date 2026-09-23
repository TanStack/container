import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fixtureAssembler} from './fixture-toolchains.mjs'
const {assembler,command,prefix,revision}=fixtureAssembler()
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex'),inputs={[assembler]:hash(assembler)}
mkdirSync('public/wasm-tables',{recursive:true})
for(const name of readdirSync('fixtures/wasm-tables').filter(name=>name.endsWith('.wat'))){
  const source='fixtures/wasm-tables/'+name,target='public/wasm-tables/'+name.replace(/\.wat$/,'.wasm')
  const run=spawnSync(command,[...prefix,source,'-o',target],{encoding:'utf8',timeout:30000})
  if(run.status!==0)throw Error(run.stderr+'\n'+run.stdout)
  if(!WebAssembly.validate(readFileSync(target)))throw Error('Node rejected '+name)
  inputs[source]=hash(source);inputs[target]=hash(target)
}
writeFileSync('public/wasm-tables/manifest.json',JSON.stringify({revision,inputs},null,2)+'\n')
console.log('Prepared table instruction fixtures')
