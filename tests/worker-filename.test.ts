import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {Worker} from 'node:worker_threads'
import {fileURLToPath} from 'node:url'

const source=readFileSync('src/sandbox/guest-worker-threads.js','utf8')
const helper=source.slice(source.indexOf('function workerFilename('),source.indexOf('\nexport class Worker'))
const normalize=new Function('URL','fileURLToPath',helper+';return workerFilename')(URL,fileURLToPath)
const errorValue=(run:()=>unknown)=>{try{run();return undefined}catch(error){return {name:(error as Error).name,code:(error as {code?:string}).code}}}

it('matches native synchronous worker filename validation',()=>{
  for(const filename of [42,null,{},'', 'child.js','child.txt']){
    const expected=errorValue(()=>new Worker(filename as string))
    expect(expected).toBeDefined()
    expect(errorValue(()=>normalize(filename,false))).toEqual(expected)
  }
  const url=new URL('data:text/javascript,export default 1')
  expect(errorValue(()=>normalize(url,true))).toEqual(errorValue(()=>new Worker(url,{eval:true})))
})

it('preserves native accepted path and URL forms without checking file existence',async()=>{
  for(const filename of ['./missing-worker-fixture.mjs','../missing-worker-fixture.mjs','/missing-worker-fixture.mjs',new URL('file:///missing-worker-fixture.mjs'),new URL('data:text/javascript,export default 1')]){
    const result=normalize(filename,false)
    expect(result.filename).toBe(filename instanceof URL?(filename.protocol==='data:'?filename.href:fileURLToPath(filename)):filename)
    const worker=new Worker(filename)
    worker.on('error',()=>{})
    await worker.terminate()
  }
  expect(normalize('console.log(42)',true)).toEqual({filename:'console.log(42)',dataURL:false})
  expect(normalize('',true)).toEqual({filename:'',dataURL:false})
})

it('keeps missing module errors asynchronous in the native control',async()=>{
  const worker=new Worker('/missing-worker-filename-audit-fixture.mjs')
  let returned=true
  const result=await new Promise(resolve=>{worker.once('error',(error:Error&{code?:string})=>resolve({returned,code:error.code}));worker.once('exit',code=>{if(code===0)resolve({unexpectedSuccess:true})})})
  expect(result).toEqual({returned:true,code:'MODULE_NOT_FOUND'})
  // Guest entry lookup and asynchronous launch error handling are unchanged.
  expect(normalize('/missing-worker-filename-audit-fixture.mjs',false).filename).toBe('/missing-worker-filename-audit-fixture.mjs')
})
