import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {fixtureAssembler} from './fixture-toolchains.mjs'
const {assembler,command,prefix}=fixtureAssembler('wast2json')
mkdirSync('public/compiler-depth',{recursive:true})
// The pinned WASI CLI preopens its working directory, not the host temp root.
const directory=mkdtempSync('public/compiler-depth/source-')
const hash=value=>createHash('sha256').update(value).digest('hex'),rows=[]
const leb=n=>{const out=[];do{let byte=n&127;n>>>=7;out.push(byte|(n?128:0))}while(n);return out}
const section=(id,bytes)=>[id,...leb(bytes.length),...bytes]
for(const depth of [1,32,256,1024,1800])for(const kind of ['block','loop','if','else']){
  const open=kind==='if'?'i32.const 1 if (result i32)':kind==='else'?'i32.const 0 if (result i32) i32.const -1 else':`${kind} (result i32)`
  const close=kind==='if'?'else i32.const -1 end':'end'
  const source=`(module (func (export "answer") (result i32)\n${(open+'\n').repeat(depth)}i32.const 42\n${(close+'\n').repeat(depth)}))`
  const name=kind+'-'+depth,wat=join(directory,name+'.wat'),wasm='public/compiler-depth/'+name+'.wasm'
  writeFileSync(wat,source)
  // WABT's own text parser exhausts its compiled linear-memory stack on deep
  // control flow. Use its binary WAST path to preserve exact nesting, then
  // independently validate and execute the resulting bytes in native Node.
  const opens=kind==='if'?[0x41,1,4,0x7f]:kind==='else'?[0x41,0,4,0x7f,0x41,0x7f,5]:[kind==='block'?2:3,0x7f]
  const closes=kind==='if'?[5,0x41,0x7f,0x0b]:[0x0b]
  const body=[0,...Array.from({length:depth},()=>opens).flat(),0x41,42,...Array.from({length:depth},()=>closes).flat(),0x0b]
  const binary=[0,97,115,109,1,0,0,0,...section(1,[1,0x60,0,1,0x7f]),...section(3,[1,0]),...section(7,[1,6,...Buffer.from('answer'),0,0]),...section(10,[1,...leb(body.length),...body])]
  const binarySource='(module binary "'+binary.map(byte=>'\\'+byte.toString(16).padStart(2,'0')).join('')+'")'
  const wast=join(directory,name+'.wast'),json=join(directory,name+'.json')
  writeFileSync(wast,binarySource)
  const run=spawnSync(command,[...prefix,'--enable-all',wast,'-o',json],{encoding:'utf8',timeout:30000})
  if(run.status!==0)throw Error(name+': '+run.stderr+'\n'+run.stdout)
  copyFileSync(join(directory,name+'.0.wasm'),wasm)
  const bytes=readFileSync(wasm)
  const actual=new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.answer()
  if(actual!==42)throw Error('Invalid depth fixture '+name)
  rows.push({name,kind,depth,expected:42,sourceSHA256:hash(source),binarySourceSHA256:hash(binarySource),wasmSHA256:hash(bytes),bytes:bytes.length})
}
writeFileSync('public/compiler-depth/manifest.json',JSON.stringify({generatorSHA256:hash(readFileSync('scripts/prepare-compiler-depth.mjs')),assemblerSHA256:hash(readFileSync(assembler)),rows},null,2)+'\n')
console.log('Prepared',rows.length,'compiler-depth fixtures')
