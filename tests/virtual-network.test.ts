import {expect,test} from 'vitest'
import {VirtualNetwork,type PortEvent} from '../src/sandbox/virtual-network'
import {readHTTPResponse} from '../src/sandbox/worker-http'

function pair(){const net=new VirtualNetwork(),server=net.listen(1,8000),client=net.connect(2,8000);return {net,server,client}}
test('port subscriptions replay sorted open ports and snapshots are independent',()=>{
  const net=new VirtualNetwork(),high=net.listen(1,9000),low=net.listen(1,8000)
  const events:PortEvent[]=[],unsubscribe=net.subscribePorts(event=>events.push(event))
  expect(events).toEqual([{type:'open',port:8000},{type:'open',port:9000}])
  const snapshot=net.listeningPorts;snapshot.push(7000)
  expect(net.listeningPorts).toEqual([8000,9000])
  expect(net.listeningPorts).not.toBe(net.listeningPorts)
  net.closeServer(1,low.id)
  expect(events.at(-1)).toEqual({type:'close',port:8000})
  unsubscribe();unsubscribe();net.closeServer(1,high.id);net.listen(2,7000)
  expect(events).toHaveLength(3)
  expect(net.listeningPorts).toEqual([7000]);net.release(1);net.release(2)
})
test('ephemeral servers emit actual ports while connections emit no port transitions',async()=>{
  const net=new VirtualNetwork(),events:PortEvent[]=[]
  net.subscribePorts(event=>events.push(event))
  const server=net.listen(1),client=net.connect(2,server.port),accepted=await net.next(1,server.id)
  if(accepted?.type!=='connection')throw Error('Missing connection')
  expect(server.port).toBeGreaterThanOrEqual(49152)
  expect(events).toEqual([{type:'open',port:server.port}])
  net.closeServer(1,server.id);net.closeServer(1,server.id)
  expect(net.connections(1,server.id)).toBe(1)
  expect(net.listeningPorts).toEqual([])
  net.destroy(1,accepted.id);net.destroy(2,client.id);net.release(1)
  expect(events).toEqual([{type:'open',port:server.port},{type:'close',port:server.port}])
})
test('shared listeners emit once per port and release closes only the final listener',()=>{
  const net=new VirtualNetwork(),events:PortEvent[]=[]
  net.subscribePorts(event=>events.push(event))
  const first=net.listen(1,8000,'127.0.0.1','shared')
  net.listen(2,8000,'127.0.0.1','shared');net.listen(2,9000)
  net.closeServer(1,first.id);net.release(1)
  expect(events).toEqual([{type:'open',port:8000},{type:'open',port:9000}])
  net.release(2);net.release(2)
  expect(events).toEqual([{type:'open',port:8000},{type:'open',port:9000},{type:'close',port:8000},{type:'close',port:9000}])
  expect(net.listeningPorts).toEqual([])
})
test('failed listens and releasing replaced listeners do not emit false transitions',()=>{
  const net=new VirtualNetwork(),events:PortEvent[]=[]
  net.subscribePorts(event=>events.push(event))
  const first=net.listen(1,8000)
  expect(()=>net.listen(2,8000)).toThrow('EADDRINUSE')
  expect(()=>net.listen(2,-1)).toThrow('ERR_SOCKET_BAD_PORT')
  expect(()=>net.listen(2,9000,'example.com')).toThrow('sandbox-local')
  expect(events).toEqual([{type:'open',port:8000}])
  net.closeServer(1,first.id);net.listen(2,8000);net.release(1)
  expect(events).toEqual([{type:'open',port:8000},{type:'close',port:8000},{type:'open',port:8000}])
  expect(net.listeningPorts).toEqual([8000]);net.release(2)
})
test('port observers cannot interrupt operations or replay when they throw',()=>{
  const net=new VirtualNetwork(),events:PortEvent[]=[]
  net.listen(1,8000)
  const unsubscribe=net.subscribePorts(()=>{throw Error('Observer failed')})
  net.subscribePorts(event=>events.push(event))
  const second=net.listen(2,9000);net.closeServer(2,second.id);net.release(1)
  expect(events).toEqual([{type:'open',port:8000},{type:'open',port:9000},{type:'close',port:9000},{type:'close',port:8000}])
  expect(net.listeningPorts).toEqual([]);unsubscribe();net.release(2)
})
test('the 32 port cap is unchanged and failed allocation emits no event',()=>{
  const net=new VirtualNetwork(),events:PortEvent[]=[]
  net.subscribePorts(event=>events.push(event))
  for(let port=8000;port<8032;port++)net.listen(1,port,'127.0.0.1','shared')
  net.listen(2,8000,'127.0.0.1','shared')
  expect(()=>net.listen(3,9000)).toThrow('Virtual socket limit exceeded')
  expect(()=>net.listen(3)).toThrow('Virtual socket limit exceeded')
  expect(net.listening).toBe(32);expect(events).toHaveLength(32)
  net.release(1);expect(net.listeningPorts).toEqual([8000]);net.release(2)
  expect(events.filter(event=>event.type==='close')).toHaveLength(32)
})
test('duplicate callbacks have independent subscriptions and events cannot be changed',()=>{
  const net=new VirtualNetwork(),events:PortEvent[]=[],listener=(event:PortEvent)=>events.push(event)
  net.subscribePorts(event=>{event.port=9999})
  const first=net.subscribePorts(listener),second=net.subscribePorts(listener)
  net.listen(1,8000)
  expect(events).toEqual([{type:'open',port:8000},{type:'open',port:8000}])
  expect(Object.isFrozen(events[0])).toBe(true)
  first();net.release(1)
  expect(events).toHaveLength(3);expect(events[2]).toEqual({type:'close',port:8000});second()
})
test('removal during emission skips unsubscribed callbacks and stale open events',()=>{
  const net=new VirtualNetwork(),events:PortEvent[]=[]
  let unsubscribe=()=>{}
  net.subscribePorts(event=>{if(event.type==='open'){unsubscribe();net.release(1)}})
  let calls=0
  unsubscribe=net.subscribePorts(()=>{calls++})
  net.subscribePorts(event=>events.push(event))
  net.listen(1,8000)
  expect(calls).toBe(0)
  expect(events).toEqual([{type:'close',port:8000}])
  expect(net.listeningPorts).toEqual([])
})
test('reentrant replay does not reopen a port closed by an earlier replay callback',()=>{
  const net=new VirtualNetwork(),events:PortEvent[]=[]
  net.listen(1,8000);net.listen(2,9000)
  net.subscribePorts(event=>{events.push(event);if(event.type==='open'&&event.port===8000)net.release(2)})
  expect(events).toEqual([{type:'open',port:8000},{type:'close',port:9000}])
  net.release(1)
})
test('host consumes queued response bytes and end after the child owner exits',async()=>{
  const net=new VirtualNetwork(),server=net.listen(1,8000),client=net.connect(0,8000)
  const accepted=await net.next(1,server.id)
  if(accepted?.type!=='connection')throw Error('Missing connection')
  const encoder=new TextEncoder()
  await net.write(1,accepted.id,encoder.encode('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nclo'))
  await net.write(1,accepted.id,encoder.encode('sing'))
  net.end(1,accepted.id)
  net.release(1)
  expect(net.listening).toBe(0);expect(net.size).toBe(1)
  expect(net.hasReferences(1)).toBe(false)
  const events:string[]=[]
  const socket={
    port:client.port,remotePort:client.remotePort,
    async read(){const event=await net.next(0,client.id);events.push(event?.type??'null');return event},
    write:(bytes:Uint8Array)=>net.write(0,client.id,bytes),
    async end(){net.end(0,client.id)},
    async close(){net.destroy(0,client.id)},
  }
  try{
    const response=await readHTTPResponse(socket,'GET',()=>socket.close())
    expect(await response.text()).toBe('closing')
    expect(events).toEqual(['data','data','end'])
    expect(net.size).toBe(0);expect(net.hasReferences(0)).toBe(false)
  }finally{net.release(0)}
})
test('owned virtual sockets transfer copied bytes and half-close independently',async()=>{
  const {net,server,client}=pair(),accepted=await net.next(1,server.id)
  expect(net.listening).toBe(1);expect(net.size).toBe(3)
  if(accepted?.type!=='connection')throw Error('Missing connection')
  const data=new Uint8Array([1,2,3]);await net.write(2,client.id,data);data[0]=9
  expect(await net.next(1,accepted.id)).toEqual({type:'data',bytes:new Uint8Array([1,2,3])})
  net.end(2,client.id);expect(await net.next(1,accepted.id)).toEqual({type:'end'})
  await net.write(1,accepted.id,new Uint8Array([42]));net.end(1,accepted.id)
  expect(await net.next(2,client.id)).toEqual({type:'data',bytes:new Uint8Array([42])})
  expect(await net.next(2,client.id)).toEqual({type:'end'})
  net.closeServer(1,server.id);expect(net.connections(1,server.id)).toBe(1)
  net.destroy(1,accepted.id);expect(await net.next(1,server.id)).toEqual({type:'close'})
  net.destroy(2,client.id);expect(net.hasReferences(1)||net.hasReferences(2)).toBe(false)
  expect(net.listening).toBe(0);expect(net.size).toBe(0)
})
test('receive quota applies backpressure and peer reads release the blocked writer',async()=>{
  const {net,server,client}=pair(),accepted=await net.next(1,server.id)
  if(accepted?.type!=='connection')throw Error('Missing connection')
  await net.write(2,client.id,new Uint8Array(65536))
  let written=false;const pending=net.write(2,client.id,new Uint8Array([42])).then(()=>written=true)
  await Promise.resolve();expect(written).toBe(false)
  expect(()=>net.write(2,client.id,new Uint8Array([1]))).toThrow('pending')
  await net.next(1,accepted.id);await pending;expect(written).toBe(true)
  expect(await net.next(1,accepted.id)).toEqual({type:'data',bytes:new Uint8Array([42])})
  net.release(1);net.release(2)
})
test('ownership, local-only policy, and resource bounds reject before mutation',async()=>{
  const {net,client}=pair()
  expect(()=>net.end(1,client.id)).toThrow('owner')
  expect(()=>net.connect(2,443,'example.com')).toThrow('sandbox-local')
  expect(()=>net.listen(3,8000)).toThrow('EADDRINUSE')
  expect(()=>net.listen(3,70000)).toThrow('ERR_SOCKET_BAD_PORT')
  expect(()=>net.write(2,client.id,new Uint8Array(65537))).toThrow('64 KiB')
  net.release(1);net.release(2)
  expect(()=>net.connect(2,8000)).toThrow('ECONNREFUSED')
})
test('owner disposal cancels pending reads and writes and allows port reuse',async()=>{
  const {net,server,client}=pair(),accepted=await net.next(1,server.id)
  if(accepted?.type!=='connection')throw Error('Missing connection')
  await net.write(2,client.id,new Uint8Array(65536))
  const blocked=net.write(2,client.id,new Uint8Array([1])).catch(error=>error.code)
  const waiting=net.next(1,server.id)
  net.release(1)
  expect(await waiting).toBe(null);expect(await blocked).toBe('EPIPE')
  expect(await net.next(2,client.id)).toEqual({type:'error',code:'ECONNRESET'})
  expect(net.listen(3,8000).port).toBe(8000)
  net.release(2);net.release(3)
})
test('releasing a closed listener does not remove a replacement listener',async()=>{
  const {net,server}=pair();net.closeServer(1,server.id)
  const replacement=net.listen(3,8000)
  net.release(1)
  const client=net.connect(4,8000)
  expect((await net.next(3,replacement.id))?.type).toBe('connection')
  net.release(2);net.release(3);net.release(4)
})

test('cluster listener broker distributes round robin and rebalances after worker removal',async()=>{
  const net=new VirtualNetwork(),first=net.listen(2,8100,'127.0.0.1','cluster:1'),second=net.listen(3,8100,'127.0.0.1','cluster:1')
  const clients=[net.connect(1,8100),net.connect(1,8100),net.connect(1,8100),net.connect(1,8100)]
  const accepted=[await net.next(2,first.id),await net.next(3,second.id),await net.next(2,first.id),await net.next(3,second.id)]
  expect(accepted.every(event=>event?.type==='connection')).toBe(true)
  net.release(2)
  const after=net.connect(1,8100);expect((await net.next(3,second.id))?.type).toBe('connection')
  expect(net.listening).toBe(1)
  net.release(1);net.release(3)
  expect(net.size).toBe(0);expect(net.listening).toBe(0)
  void clients;void after
})

test('ordinary listeners and unrelated cluster primaries still get EADDRINUSE',()=>{
  const net=new VirtualNetwork();net.listen(1,8200)
  expect(()=>net.listen(2,8200)).toThrow('EADDRINUSE');net.release(1)
  net.listen(2,8200,'127.0.0.1','cluster:1')
  expect(()=>net.listen(3,8200,'127.0.0.1','cluster:9')).toThrow('EADDRINUSE')
  expect(()=>net.listen(2,8200,'127.0.0.1','cluster:1')).toThrow('EADDRINUSE')
  net.release(2)
})

test('handle flooding is bounded and ownership cleanup restores capacity',()=>{
  const net=new VirtualNetwork(),server=net.listen(1,8000)
  let clients=0
  try{for(;;){net.connect(2,8000);clients++}}catch(error){expect((error as any).code).toBe('EMFILE')}
  expect(clients).toBe(127)
  net.release(1);net.release(2)
  expect(net.listen(3,8000).port).toBe(8000)
  net.release(3)
  expect(net.hasReferences(1)||net.hasReferences(2)||net.hasReferences(3)).toBe(false)
})
