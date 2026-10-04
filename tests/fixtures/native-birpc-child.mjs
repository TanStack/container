import v8 from 'node:v8'
import {ViteNodeRunner} from 'vite-node/client'
import {readFileSync,realpathSync} from 'node:fs'
import {dirname,basename} from 'node:path'
const {c:createRuntimeRpc}=await import(/* @vite-ignore */ new URL('./chunks/rpc.-pEldfrD.js',import.meta.resolve('vitest')).href)
const {rpc}=createRuntimeRpc({
  serialize:v8.serialize,deserialize:bytes=>v8.deserialize(Buffer.from(bytes)),
  post:bytes=>process.send(bytes),on:callback=>process.on('message',callback),timeout:2000,
})
const answer=await rpc.add(2,3)
if(process.cwd()!==realpathSync(await rpc.directory()))throw Error('Fork launch cwd changed')
if(answer!==5)throw Error('RPC returned the wrong answer')
console.log('rpc answer:5')
const graph=await rpc.collections()
if(!(graph.date instanceof Date)||graph.date.getTime()!==42||graph.date!==graph.again||
  !(graph.map instanceof Map)||!(graph.set instanceof Set)||graph.map.get(graph.map)!==graph.set||
  !graph.set.has(graph.date)||!graph.set.has(graph.map)||graph.bigint!==-(2n**120n))throw Error('RPC collection identity changed')
if(!(graph.pattern instanceof RegExp)||graph.pattern!==graph.patternAgain||
  graph.pattern.source!=='你好[abc]+'||graph.pattern.flags!=='dgimsuy')throw Error('RPC RegExp changed')
if(!(graph.view instanceof Int16Array)||graph.view!==graph.viewAgain||
  graph.view[0]!==123||graph.view[1]!==-456||!(graph.data instanceof DataView)||
  graph.data.byteLength!==2||graph.data.getUint8(0)!==1||graph.data.getUint8(1)!==2)
  throw Error('RPC binary view changed')
if(!(graph.buffer instanceof ArrayBuffer)||graph.buffer!==graph.bufferAgain||
  new Uint8Array(graph.buffer).join(',')!=='1,2,255')throw Error('RPC ArrayBuffer changed')
const module=await rpc.fetch('/@vite/env','ssr')
if(module.code!=='export default 42'||module.externalize!==undefined||module.map!==null)
  throw Error('RPC returned the wrong module result')
const runner=new ViteNodeRunner({root:'/app',fetchModule:id=>rpc.fetch(id,'ssr')})
const evaluated=await runner.executeId('/app/rpc-evaluated.mjs')
if(evaluated.default!==42)throw Error('ViteNodeRunner returned the wrong module result')
const fileRunner=new ViteNodeRunner({root:'/app',fetchModule:async()=>{
  const result=await rpc.fetchFile()
  return {code:readFileSync(result.id,'utf8')}
}})
if((await fileRunner.executeId('/app/rpc-file-evaluated.mjs')).default!==43)
  throw Error('ViteNodeRunner returned the wrong file-backed result')
const temporaryModule=await rpc.fetchFile()
const originalCwd=process.cwd()
const parentCwd=await rpc.parentDirectory()
try{
  process.chdir(dirname(temporaryModule.id))
  if(readFileSync(basename(temporaryModule.id),'utf8')!=='__vite_ssr_exports__.default = await Promise.resolve(43)')
    throw Error('Relative scratch read failed')
  const current=process.cwd()
  let failed=false
  try{process.chdir('missing-directory')}catch(error){failed=error.code==='ENOENT'}
  if(!failed||process.cwd()!==current)throw Error('Failed chdir changed cwd')
  process.chdir(dirname(current))
  if(await rpc.parentDirectory()!==parentCwd)throw Error('Fork chdir changed parent cwd')
}finally{process.chdir(originalCwd)}
process.disconnect()
