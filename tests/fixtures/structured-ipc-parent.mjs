import {fork} from 'node:child_process'
import {makePayload} from './structured-clone-values.mjs'
const child=fork(new URL('./structured-ipc-child.mjs',import.meta.url),[],{serialization:'advanced',stdio:'pipe',execArgv:[]})
const result=new Promise((resolve,reject)=>{child.on('error',reject);child.on('message',resolve)})
child.send(makePayload())
console.log(JSON.stringify(await result))
