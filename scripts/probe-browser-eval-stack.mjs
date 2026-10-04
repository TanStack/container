import {chromium,firefox,webkit} from 'playwright'
import {createServer} from 'node:http'

// Compare actual captured frames, never insert a source location into a stack.
const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
try{
for(const engine of [chromium,firefox,webkit]){
  const browser=await engine.launch()
  try{
    const page=await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const rows=await page.evaluate(async()=>{
      const probe=async()=>{
      const rows=[]
      for(const [name,body] of [
        ['sync','(function own(){throw new Error("owned")})'],
        ['async','(async function own(){throw new Error("owned")})'],
        ['async-after-await','(async function own(){await Promise.resolve();throw new Error("owned")})'],
        ['async-finally','(async function own(){try{throw new Error("owned")}finally{}})'],
        ['async-call','(async function own(){function fail(){throw new Error("owned")}try{return fail()}finally{}})'],
      ]){
        for(const prefix of ['/app/','file:///app/','https://sandbox.invalid/app/']){
          const source=body+'\n//# sourceURL='+prefix+name+'.js\n'
          const modes=['eval','function','module']
          if(typeof importScripts==='function')modes.push('classic-script')
          for(const mode of modes){
            let url
            if(mode==='module')url=URL.createObjectURL(new Blob(['export default '+body],{type:'text/javascript'}))
            if(mode==='classic-script'){
              url=URL.createObjectURL(new Blob(['globalThis.__stackProbeFunction='+body],{type:'text/javascript'}))
              importScripts(url)
            }
            const evaluate=mode==='eval'?(0,eval)(source):mode==='function'?new Function('return '+source)():mode==='classic-script'?globalThis.__stackProbeFunction:(await import(url)).default
            try{await evaluate()}
            catch(error){rows.push({name,prefix,mode,url,stack:error.stack,sourceURL:error.sourceURL,line:error.line,column:error.column})}
            finally{if(url)URL.revokeObjectURL(url)}
          }
        }
      }
      const selfURL=URL.createObjectURL(new Blob(['export default (async function own(){return own})'],{type:'text/javascript'}))
      try{
        const own=(await import(selfURL)).default
        rows.push({name:'module-self',self:await own()===own})
      }finally{URL.revokeObjectURL(selfURL)}
      if(typeof importScripts==='function'){
        const loaderURL=URL.createObjectURL(new Blob(['export default function load(url){importScripts(url)}'],{type:'text/javascript'}))
        const scriptURL=URL.createObjectURL(new Blob(['globalThis.__classicSelf=(async function own(){return own});globalThis.__classicOrder=42'],{type:'text/javascript'}))
        try{
          const load=(await import(loaderURL)).default
          load(scriptURL)
          const own=globalThis.__classicSelf
          rows.push({name:'classic-module-loader-self',self:await own()===own,synchronous:globalThis.__classicOrder===42,functionName:own.name})
          const failureURL=URL.createObjectURL(new Blob(['throw new TypeError("classic script failure")'],{type:'text/javascript'}))
          try{
            try{load(failureURL);rows.push({name:'classic-top-level-error',missing:true})}
            catch(error){rows.push({name:'classic-top-level-error',errorName:error.name,message:error.message,stack:error.stack,url:failureURL})}
          }finally{URL.revokeObjectURL(failureURL)}
          const declarationsURL=URL.createObjectURL(new Blob(['let __classicLexical=41;const __classicConstant=1;var __classicVariable=40;'],{type:'text/javascript'}))
          const readURL=URL.createObjectURL(new Blob(['globalThis.__classicBindings={answer:__classicLexical+__classicConstant,variable:__classicVariable,lexicalProperty:Object.hasOwn(globalThis,"__classicLexical")};'],{type:'text/javascript'}))
          try{
            load(declarationsURL);load(readURL)
            rows.push({name:'classic-declarations',...globalThis.__classicBindings})
          }finally{URL.revokeObjectURL(declarationsURL);URL.revokeObjectURL(readURL)}
        }finally{
          delete globalThis.__classicSelf;delete globalThis.__classicOrder
          URL.revokeObjectURL(scriptURL);URL.revokeObjectURL(loaderURL)
        }
      }
      return rows
      }
      const pageRows=await probe()
      const workerURL=URL.createObjectURL(new Blob([`self.onmessage=async()=>{try{postMessage({rows:await (${probe.toString()})()})}catch(error){postMessage({error:String(error)})}}`],{type:'text/javascript'}))
      const worker=new Worker(workerURL)
      try{
        const workerRows=await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('Worker stack control timed out')),10000)
          worker.onmessage=event=>{clearTimeout(timer);event.data.error?reject(Error(event.data.error)):resolve(event.data.rows)}
          worker.onerror=event=>{clearTimeout(timer);reject(Error(event.message))}
          worker.postMessage(null)
        })
        return [...pageRows.map(row=>({...row,scope:'page'})),...workerRows.map(row=>({...row,scope:'worker'}))]
      }finally{worker.terminate();URL.revokeObjectURL(workerURL)}
    })
    console.log(JSON.stringify({engine:engine.name(),rows:process.env.PROBE_FULL_STACKS==='1'?rows:rows.map(row=>({...row,stack:row.stack?.split('\n').slice(0,2).join('\n')}))}))
  }finally{await browser.close()}
}
}finally{await new Promise(resolve=>server.close(resolve))}
