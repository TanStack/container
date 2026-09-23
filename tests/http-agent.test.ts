import {afterEach,expect,test} from 'vitest'
import {createServer,type RequestListener,type Server} from 'node:http'
// @ts-expect-error The guest facade is intentionally exercised with native TCP here.
import {Agent,request} from '../src/sandbox/guest-http.js'

let server:Server|undefined
afterEach(()=>new Promise<void>(resolve=>server?.close(()=>{server=undefined;resolve()})??resolve()))

function listen(handler:RequestListener){
  return new Promise<number>(resolve=>{server=createServer(handler);server.listen(0,'127.0.0.1',()=>resolve((server!.address() as {port:number}).port))})
}
function get(port:number,agent:any,path='/'){
  return new Promise<{body:string,reused:boolean}>((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path,agent},(res:any)=>{let body='';res.on('data',(chunk:any)=>body+=chunk);res.on('end',()=>resolve({body,reused:req.reusedSocket}))});req.on('error',reject);req.end()})
}

test('keep-alive reuses one idle socket for sequential requests',async()=>{
  let connections=0
  const port=await listen((_req,res)=>res.end('ok'))
  server!.on('connection',()=>connections++)
  const agent=new Agent({keepAlive:true})
  expect(await get(port,agent,'/one')).toEqual({body:'ok',reused:false})
  expect(await get(port,agent,'/two')).toEqual({body:'ok',reused:true})
  expect(connections).toBe(1)
  expect(Object.values(agent.freeSockets).flat()).toHaveLength(1)
  agent.destroy()
})

test('maxSockets queues work and hands the live socket to the next request',async()=>{
  let release!:()=>void,connections=0
  const gate=new Promise<void>(resolve=>release=resolve)
  const port=await listen(async(req,res)=>{if(req.url==='/one')await gate;res.end(req.url)})
  server!.on('connection',()=>connections++)
  const agent=new Agent({keepAlive:true,maxSockets:1})
  const one=get(port,agent,'/one'),two=get(port,agent,'/two')
  await new Promise(resolve=>setTimeout(resolve,10))
  expect(Object.values(agent.requests).flat()).toHaveLength(1)
  release()
  expect(await Promise.all([one,two])).toEqual([{body:'/one',reused:false},{body:'/two',reused:true}])
  expect(connections).toBe(1)
  agent.destroy()
})

test('finite maxTotalSockets is rejected instead of silently ignored',()=>{
  expect(()=>new Agent({maxTotalSockets:1})).toThrowError(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
})
