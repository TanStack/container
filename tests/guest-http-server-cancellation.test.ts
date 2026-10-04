import {expect,test,vi} from 'vitest'
import {createServer as nodeServer} from 'node:http'
import {createConnection} from 'node:net'
// @ts-expect-error Exercise the guest HTTP facade with native TCP.
import {createServer as guestServer} from '../src/sandbox/guest-http.js'

for(const [name,createServer] of [['Node',nodeServer],['guest',guestServer]] as const){
  test(name+' closes an unfinished response when its client disconnects',async()=>{
    let received!:()=>void,closed=0
    const request=new Promise<void>(resolve=>{received=resolve})
    const server=createServer((_req:any,res:any)=>{
      res.on('close',()=>{closed++})
      received()
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const socket=createConnection(server.address().port,'127.0.0.1')
    try{
      await new Promise<void>(resolve=>socket.once('connect',resolve))
      socket.write('GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n')
      await request
      socket.destroy()
      await vi.waitFor(()=>expect(closed).toBe(1))
    }finally{
      socket.destroy()
      server.closeAllConnections()
      await new Promise<void>(resolve=>server.close(resolve))
    }
  })
}
