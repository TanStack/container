import {createServer} from 'node:http'
import {firefox} from 'playwright'

const url=process.env.REGISTRY_CONTROL_URL??'https://registry.npmjs.org/@jridgewell/trace-mapping/-/trace-mapping-0.3.31.tgz'
const target=new URL(url)
if(target.origin!=='https://registry.npmjs.org'||target.username||target.password||target.hash)
  throw Error('Registry control requires an exact npm registry URL')
const concurrency=Number(process.env.REGISTRY_CONTROL_CONCURRENCY??1)
if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4)
  throw Error('Registry control concurrency must be between1 and4')
let failed=0
const server=createServer((request,response)=>{
  if(request.url==='/isolated'){
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
  }
  response.setHeader('Content-Type','text/html')
  response.end('<!doctype html><title>Registry fetch control</title>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try{
  browser=await firefox.launch({headless:true})
  for(const path of ['/plain','/isolated']){
    const page=await browser.newPage()
    page.on('requestfailed',request=>console.log('REQUEST_FAILED',JSON.stringify({path,url:request.url(),failure:request.failure()})))
    await page.goto(`http://127.0.0.1:${server.address().port}${path}`)
    const result=await page.evaluate(async({url,concurrency})=>{
      const fetchPackage=async()=>{
        try{
          const response=await fetch(url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)})
          const bytes=await response.arrayBuffer()
          return {status:response.status,type:response.type,bytes:bytes.byteLength}
        }catch(error){return {error:String(error)}}
      }
      const main=[]
      for(let index=0;index<3;index++)main.push(...await Promise.all(Array.from({length:concurrency},()=>fetchPackage())))
      const workerURL=URL.createObjectURL(new Blob([
        `const url=${JSON.stringify(url)};const fetchPackage=${fetchPackage.toString()};(async()=>{const results=[];for(let i=0;i<3;i++)results.push(...await Promise.all(Array.from({length:${concurrency}},()=>fetchPackage())));postMessage(results)})()`
      ],{type:'text/javascript'}))
      const worker=new Worker(workerURL)
      try{
        const results=await new Promise((resolve,reject)=>{
          worker.onmessage=event=>resolve(event.data)
          worker.onerror=event=>reject(Error(event.message))
        })
        return {isolated:crossOriginIsolated,main,worker:results}
      }finally{worker.terminate();URL.revokeObjectURL(workerURL)}
    },{url,concurrency})
    failed+= [...result.main,...result.worker].filter(row=>row.error||row.status!==200||row.bytes<1).length
    console.log('REGISTRY_FETCH_CONTROL',JSON.stringify({path,url,concurrency,...result}))
    await page.close()
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
if(failed)throw Error(`${failed} registry fetch controls failed`)
