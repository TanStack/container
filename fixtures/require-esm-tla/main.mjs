import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let code
try{require('./value.mjs')}catch(error){code=error.code}
const untouched=globalThis.tlaRan===undefined
const value=await import('./value.mjs')
console.log(JSON.stringify({code,untouched,value:value.default,ran:globalThis.tlaRan}))
