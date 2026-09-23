import {Worker} from 'node:worker_threads'
import {fileURLToPath} from 'node:url'
const worker=new Worker(fileURLToPath(new URL('./worker-output-child.mjs',import.meta.url)),{stdout:true,stderr:true,execArgv:[]})
const collect=stream=>new Promise((resolve,reject)=>{
  const chunks=[]
  stream.on('data',chunk=>chunks.push(chunk))
  stream.on('error',reject)
  stream.on('end',()=>resolve([...Buffer.concat(chunks)]))
})
const stdout=collect(worker.stdout),stderr=collect(worker.stderr)
const code=new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',resolve)})
console.log(JSON.stringify({stdout:await stdout,stderr:await stderr,code:await code}))
