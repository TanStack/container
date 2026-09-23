import {expect,test} from 'vitest'
import {VirtualDatagramNetwork} from '../src/sandbox/virtual-datagram-network'
import {spawnSync} from 'node:child_process'

test('datagrams are atomic copied packets with native-shaped rinfo',async()=>{
  const net=new VirtualDatagramNetwork(),receiver=net.create(1,'udp4'),sender=net.create(2,'udp4')
  const address=net.bind(1,receiver.id,8123),payload=new Uint8Array([1,2,3])
  expect(address).toEqual({address:'0.0.0.0',family:'IPv4',port:8123})
  expect(net.send(2,sender.id,payload,8123,'127.0.0.1')).toBe(3);payload[0]=9
  expect(await net.next(1,receiver.id)).toEqual({type:'message',bytes:new Uint8Array([1,2,3]),rinfo:{address:'127.0.0.1',family:'IPv4',port:49152,size:3}})
  net.release(1);net.release(2);expect(net.size).toBe(0);expect(net.bound).toBe(0)
})

test('connected sends, disconnect, virtual multicast and reference state stay local',async()=>{
  const net=new VirtualDatagramNetwork(),a=net.create(1,'udp6',true),a2=net.create(3,'udp6',true),b=net.create(2,'udp6')
  net.bind(1,a.id,9000);net.bind(3,a2.id,9000);net.membership(1,a.id,'ff02::1',true,'virtual');net.membership(3,a2.id,'ff02::1',true);net.connect(2,b.id,9000,'ff02::1')
  expect(net.remoteAddress(2,b.id)).toEqual({address:'ff02::1',family:'IPv6',port:9000})
  net.send(2,b.id,new Uint8Array([7]));expect((await net.next(1,a.id))?.type).toBe('message');expect((await net.next(3,a2.id))?.type).toBe('message')
  net.ref(2,b.id,false);expect(net.hasReferences(2)).toBe(false);net.disconnect(2,b.id)
  expect(()=>net.remoteAddress(2,b.id)).toThrow('NOT_CONNECTED')
  expect(()=>net.send(2,b.id,new Uint8Array(),9000,'example.com')).toThrow('sandbox-local')
  expect(()=>net.membership(1,a.id,'ff02::1',true,'en0')).toThrow('interfaces')
  net.release(1);net.release(2);net.release(3)
})

test('families, ports, ownership and cleanup remain separate from stream sockets',()=>{
  const net=new VirtualDatagramNetwork(),four=net.create(1,'udp4'),six=net.create(1,'udp6')
  expect(net.bind(1,four.id,7000).family).toBe('IPv4');expect(net.bind(1,six.id,7000).family).toBe('IPv6')
  expect(()=>net.address(2,four.id)).toThrow('owner');expect(()=>net.bind(1,four.id,7001)).toThrow('ALREADY_BOUND')
  net.close(1,four.id);expect(net.bind(1,net.create(1,'udp4').id,7000).port).toBe(7000)
  net.release(1);expect(net.size).toBe(0)
})

test('native control records unbound address and close callback ordering without network I/O',()=>{
  const result=spawnSync(process.execPath,['tests/fixtures/node-dgram.mjs'],{encoding:'utf8'})
  expect(result.status,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(['EBADF','sync','close','callback'])
})
