import {readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'

import {fixtureAssembler} from './fixture-toolchains.mjs'
const {assembler,command,prefix}=fixtureAssembler()
const source='fixtures/shared-wasm/atomic.wat',target='fixtures/shared-wasm/atomic.wasm'
const run=spawnSync(command,[...prefix,'--enable-threads',source,'-o',target],{encoding:'utf8',timeout:30000})
if(run.status!==0)throw Error(run.stderr+'\n'+run.stdout+'\n'+(run.error??''))
const bytes=readFileSync(target)
if(!WebAssembly.validate(bytes))throw Error('Native WebAssembly rejected shared-memory fixture')
const sha=data=>createHash('sha256').update(data).digest('hex')
writeFileSync('fixtures/shared-wasm/manifest.json',JSON.stringify({sourceSHA256:sha(readFileSync(source)),wasmSHA256:sha(bytes),assemblerSHA256:sha(readFileSync(assembler)),bytes:bytes.length},null,2)+'\n')
console.log('Prepared shared WASM fixture:',bytes.length,'bytes')
