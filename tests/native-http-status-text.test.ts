import {test,expect} from 'vitest'
import {createServer} from 'node:net'
import {get,createServer as createHTTPServer} from 'node:http'
import {readHTTPResponse,WorkerHTTP} from '../src/sandbox/worker-http'

test('virtual HTTP preserves reason phrases like actual Node HTTP',async()=>{
  for(const [status,phrase] of [[200,'Custom result'],[204,'Empty'],[200,'  all done  '],[200,'Cafe\xe9'],[200,'\tspaced\t']] as const){
    const wire=`HTTP/1.1 ${status} ${phrase}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
    const server=createServer(socket=>socket.once('data',()=>socket.end(Buffer.from(wire,'latin1'))))
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
    try{
      const address=server.address()
      if(!address||typeof address==='string')throw Error('Expected a TCP address')
      const statusText=await new Promise<string>((resolve,reject)=>{
        get(`http://127.0.0.1:${address.port}/`,response=>{resolve(response.statusMessage??'');response.resume()}).on('error',reject)
      })
      let reads=0
      const bytes=Uint8Array.from(wire,character=>character.charCodeAt(0))
      const socket={port:1,remotePort:2,async read(){return reads++===0?{type:'data' as const,bytes}:{type:'end' as const}},async write(_bytes:Uint8Array){},async end(){},async close(){}}
      const response=await readHTTPResponse(socket,'GET',socket.close)
      expect(response.status).toBe(status)
      expect(response.statusText,JSON.stringify(phrase)).toBe(statusText)
      expect(response.clone().statusText).toBe(statusText)
      await response.text()
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
  }
},10_000)

test('virtual HTTP sends Latin-1 request header bytes like Node HTTP',async()=>{
  for(const value of ['plain','Cafe\xe9','\xa0value\xa0']){
    let expected:string|undefined
    const server=createHTTPServer((request,response)=>{
      expected=request.headers['x-value'] as string|undefined;response.end()
    })
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
    try{
      const address=server.address()
      if(!address||typeof address==='string')throw Error('Expected an HTTP address')
      await new Promise<void>((resolve,reject)=>{
        get(`http://127.0.0.1:${address.port}/`,{headers:{'x-value':value}},response=>{
          response.resume();response.on('end',resolve)
        }).on('error',reject)
      })
      let sent='',reads=0
      const socket={port:1,remotePort:2,async read(){return reads++===0?{type:'data' as const,bytes:new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')}:{type:'end' as const}},async write(bytes:Uint8Array){sent+=Buffer.from(bytes).toString('latin1')},async end(){},async close(){}}
      const response=await new WorkerHTTP({connect:async()=>socket},1234).fetch(new Request('http://localhost/',{headers:{'x-value':value}}))
      await response.text()
      expect(/^x-value: (.*)\r$/m.exec(sent)?.[1]).toBe(expected)
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
  }
},10_000)

test('virtual HTTP trims only HTTP whitespace from header values',async()=>{
  for(const value of [' \tplain\t ','\xa0value\xa0',' \t\xa0value\xa0\t ']){
    const wire=`HTTP/1.1 200 OK\r\nX-Value:${value}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
    const server=createServer(socket=>socket.once('data',()=>socket.end(Buffer.from(wire,'latin1'))))
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
    try{
      const address=server.address()
      if(!address||typeof address==='string')throw Error('Expected a TCP address')
      const expected=await new Promise<string|undefined>((resolve,reject)=>{
        get(`http://127.0.0.1:${address.port}/`,response=>{
          resolve(response.headers['x-value'] as string|undefined);response.resume()
        }).on('error',reject)
      })
      let reads=0
      const bytes=Uint8Array.from(wire,character=>character.charCodeAt(0))
      const socket={port:1,remotePort:2,async read(){return reads++===0?{type:'data' as const,bytes}:{type:'end' as const}},async write(_bytes:Uint8Array){},async end(){},async close(){}}
      const response=await readHTTPResponse(socket,'GET',socket.close)
      expect(response.headers.get('x-value'),JSON.stringify(value)).toBe(expected)
      await response.text()
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
  }
},10_000)
