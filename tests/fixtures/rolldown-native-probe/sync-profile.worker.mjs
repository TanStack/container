import {NativeRolldownParser} from '../../../src/compiler/rolldown-parser.ts'

const session=await NativeRolldownParser.open({
  createWorker:()=>new Worker('/parser/worker.js',{type:'module'}),
  wasmURL:location.origin+'/parser/parser.wasm',pthreadURL:location.origin+'/parser/pthread.js',
  policy:{timeoutMs:30000,maxSourceBytes:1024*1024},profile:'sync',
})
try{
  const cache=session.createTsconfigCache()
  const parsed=session.parseSync('/input.ts','export const answer: number = 42',{lang:'ts'})
  const transformed=session.transformSync('/input.ts','export const answer: number = 42',{lang:'ts',sourcemap:true},cache)
  const size=session.tsconfigCacheSize(cache);session.clearTsconfigCache(cache)
  postMessage({parsed:{errors:parsed.errors.length,hasProgram:typeof parsed.program==='string'&&parsed.program.length>0},transformed:{code:transformed.code,errors:transformed.errors},size,resources:await session.close()})
}catch(error){postMessage({error:String(error),stack:error?.stack})}
finally{if(!session.closed)await session.close()}
