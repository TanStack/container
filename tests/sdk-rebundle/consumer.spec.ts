import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'

const supplied=process.env.VITE_CONSUMER_OUTPUT
if(!supplied)throw Error('VITE_CONSUMER_OUTPUT must identify a built outer Vite app')
const root=realpathSync(supplied)
let server:Server,url:string
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    try{
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return}
      const pathname=decodeURIComponent(new URL(req.url!,'http://localhost').pathname)
      const file=realpathSync(resolve(root,pathname==='/'?'index.html':pathname.slice(1)))
      if(!file.startsWith(root+sep))throw Error('outside consumer output')
      const bytes=readFileSync(file)
      res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.css':'text/css'} as Record<string,string>)[extname(file)]??'application/octet-stream')
      res.setHeader('X-Content-Type-Options','nosniff')
      res.setHeader('Content-Length',bytes.length)
      res.end(req.method==='HEAD'?undefined:bytes)
    }catch{res.writeHead(404);res.end()}
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`
})
test.afterAll(async()=>{await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))})

test('outer Vite production bundle runs installed SDK module, compiler and shell',async({page},info)=>{
  const pageErrors:string[]=[],failedRequests:{url:string;error:string|null}[]=[],requestURLs:string[]=[],httpFailures:{url:string;status:number}[]=[]
  page.on('pageerror',error=>pageErrors.push(error.message))
  page.on('request',request=>requestURLs.push(request.url()))
  page.on('requestfailed',request=>failedRequests.push({url:request.url(),error:request.failure()?.errorText??null}))
  page.on('response',response=>{if(response.status()>=400)httpFailures.push({url:response.url(),status:response.status()})})
  try{
    await page.goto(url)
    await page.waitForFunction(()=>['passed','failed'].includes((window as any).result?.status))
    const result=await page.evaluate(()=>(window as any).result)
    expect(result.status,JSON.stringify(result)).toBe('passed')
    expect(result.checks.module.stdout).toBe('rebundled SDK\n')
    expect(result.checks.compiled.stdout).toBe('42\n')
    expect(result.checks.shell).toEqual({code:0,stdout:'rebundled SDK\n',stderr:'',error:''})
    expect(pageErrors).toEqual([])
    expect(failedRequests).toEqual([])
    expect(httpFailures).toEqual([])
    expect(requestURLs.every(request=>request.startsWith(url)||request.startsWith('blob:'))).toBe(true)
  }finally{
    let result:unknown
    try{result=await page.evaluate(()=>(window as any).result??null)}catch(error){result={observationError:String(error)}}
    await info.attach('sdk-rebundle.json',{body:JSON.stringify({root,result,pageErrors,failedRequests,httpFailures,requestURLs}),contentType:'application/json'})
  }
})
