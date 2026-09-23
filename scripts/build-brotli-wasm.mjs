import {copyFileSync,mkdirSync} from 'node:fs'

const source='node_modules/wasm-brotli/wasm_brotli_browser_bg.wasm'
const output='public/kernel-runtime/brotli.wasm'
mkdirSync('public/kernel-runtime',{recursive:true})
copyFileSync(source,output)
