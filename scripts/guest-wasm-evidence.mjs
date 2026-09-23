import {readFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
export const guestWasmInputHashes=()=>{
  const paths=['fixtures/guest-wasm-cases.mjs','fixtures/guest-wasm-allocation-native.c','fixtures/wasm-table-cases.mjs','scripts/prepare-wasm-tables.mjs',
    'scripts/probe-guest-wasm.mjs','scripts/probe-guest-wasm-allocation.mjs','scripts/probe-guest-wasm-native.mjs','scripts/probe-wasm-budget.mjs',
    'scripts/guest-wasm-evidence.mjs','src/sandbox/guest-wasm.c','src/sandbox/guest-wasm.js',
    'public/quickjs-als-wasm/engine.wasm','public/quickjs-als-wasm/engine.mjs',
    'public/wasm-interpreter-probe/controls.wasm','public/wasm-interpreter-probe/webpack-md4.wasm',
    ...['fixtures/guest-wasm','public/guest-wasm','public/compiler-depth','fixtures/wasm-tables','public/wasm-tables'].flatMap(directory=>
      readdirSync(directory).filter(name=>/\.(wat|wasm|json)$/.test(name)).map(name=>directory+'/'+name))]
  return Object.fromEntries(paths.sort().map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]))
}
