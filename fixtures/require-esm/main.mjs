import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let microtask=false
Promise.resolve().then(()=>microtask=true)
const required=require('./value.mjs')
const stayedQueued=!microtask
const imported=await import('./value.mjs')
required.bump()
console.log(JSON.stringify({same:required===imported,value:imported.value,stayedQueued,evaluations:globalThis.evaluations}))
