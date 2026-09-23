import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {WASI} from 'node:wasi'
import {fixtureAssembler} from './fixture-toolchains.mjs'

// Run the pinned fixture assembler in a separate Node process so callers
// can enforce a deadline. No old temporary native toolchain is required.
const args=process.argv.slice(2)
let tool='wat2wasm',source
if(args[0]?.startsWith('--tool='))tool=args.shift().slice('--tool='.length)
if(args[0]?.startsWith('--wasm3-root='))source=args.shift().slice('--wasm3-root='.length)
if(!args.length)throw Error('Usage: node scripts/assemble-wat.mjs [--tool=wat2wasm|wast2json] [--wasm3-root=PATH] INPUT -o OUTPUT')
const assembler=readFileSync(fixtureAssembler(tool,{source}).assembler)
const wasi=new WASI({version:'preview1',args:[tool,...args],env:{},preopens:{'.':resolve('.')},returnOnExit:true})
const module=await WebAssembly.compile(assembler)
const instance=await WebAssembly.instantiate(module,wasi.getImportObject())
process.exitCode=wasi.start(instance)
