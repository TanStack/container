import {test,expect} from 'vitest'
import {spawnSync} from 'node:child_process'
// @ts-expect-error Guest helper is intentionally plain JavaScript.
import {createWASIPoll} from '../src/sandbox/guest-wasi-poll.js'

function fixture(){
  const memory=new WebAssembly.Memory({initial:1}),view=new DataView(memory.buffer)
  const subscription=(index:number,userdata:bigint,timeout:bigint,flags=0,id=1)=>{
    const p=64+index*48
    view.setBigUint64(p,userdata,true);view.setUint8(p+8,0);view.setUint32(p+16,id,true)
    view.setBigUint64(p+24,timeout,true);view.setBigUint64(p+32,0n,true);view.setUint16(p+40,flags,true)
  }
  const events=()=>Array.from({length:view.getUint32(2048,true)},(_,index)=>{
    const p=1024+index*32
    return {userdata:view.getBigUint64(p,true),error:view.getUint16(p+8,true),type:view.getUint8(p+10)}
  })
  return {memory,view,subscription,events}
}
// Tiny reactor with an exported memory, allowing native WASI to bind it.
const reactor=Uint8Array.from([0,97,115,109,1,0,0,0,5,3,1,0,1,7,10,1,6,109,101,109,111,114,121,2,0])
test('short relative clock poll matches native WASI',()=>{
  const guest=fixture();guest.subscription(0,42n,1_000_000n)
  const control=spawnSync(process.execPath,['--input-type=module','-e',`
    import {WASI} from 'node:wasi';const wasi=new WASI({version:'preview1'});
    const instance=new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(${JSON.stringify([...reactor])})));wasi.initialize(instance);
    new Uint8Array(instance.exports.memory.buffer).set(Uint8Array.from(${JSON.stringify([...new Uint8Array(guest.memory.buffer).subarray(0,112)])}));
    const code=wasi.wasiImport.poll_oneoff(64,1024,1,2048),v=new DataView(instance.exports.memory.buffer);
    console.log(JSON.stringify({code,count:v.getUint32(2048,true),userdata:String(v.getBigUint64(1024,true)),error:v.getUint16(1032,true),type:v.getUint8(1034)}));
  `],{encoding:'utf8',timeout:3000})
  expect(control.status,control.stderr+String(control.error??'')).toBe(0)
  let now=0n
  const {poll_oneoff:poll}=createWASIPoll({getMemory:()=>guest.memory,clockNowNs:()=>now,wait:(ms:number)=>{now+=BigInt(ms)*1_000_000n}})
  const code=poll(64,1024,1,2048),events=guest.events()
  expect({code,count:events.length,...events[0],userdata:String(events[0].userdata)}).toEqual(JSON.parse(control.stdout))
})
test.each([0,1])('expired clocks never park, flags %s',flags=>{
  const f=fixture();f.subscription(0,42n,0n,flags)
  const api=createWASIPoll({getMemory:()=>f.memory,clockNowNs:()=>100n,wait:()=>{throw Error('unexpected wait')}})
  expect(api.poll_oneoff(64,1024,1,2048)).toBe(0);expect(f.events()).toEqual([{userdata:42n,error:0,type:0}])
})
test('relative clocks park until earliest deadline and return every ready event',()=>{
  const f=fixture();let now=10_000_000n;const waits:number[]=[]
  f.subscription(0,10n,5_000_000n);f.subscription(1,20n,5_000_000n);f.subscription(2,30n,9_000_000n)
  const {poll_oneoff:poll}=createWASIPoll({getMemory:()=>f.memory,clockNowNs:()=>now,wait:(ms:number)=>{waits.push(ms);now+=BigInt(Math.ceil(ms*1e6))}})
  expect(poll(64,1024,3,2048)).toBe(0)
  expect(waits).toEqual([5]);expect(f.events()).toEqual([{userdata:10n,error:0,type:0},{userdata:20n,error:0,type:0}])
})
test('absolute clocks use their respective clocks and park without spinning',()=>{
  const f=fixture();let elapsed=0n;const waits:number[]=[]
  f.subscription(0,1n,1_005_000_000n,1,0);f.subscription(1,2n,15_000_000n,1,1)
  const {poll_oneoff:poll}=createWASIPoll({getMemory:()=>f.memory,clockNowNs:(id:number)=>(id===0?1_000_000_000n:10_000_000n)+elapsed,wait:(ms:number)=>{waits.push(ms);elapsed+=BigInt(Math.ceil(ms*1e6))}})
  expect(poll(64,1024,2,2048)).toBe(0);expect(waits).toEqual([5]);expect(f.events()).toHaveLength(2)
})
test('long waits are chunked, yield parks, and cancellation propagates',()=>{
  const f=fixture();let now=0n;const waits:number[]=[]
  f.subscription(0,42n,2_500_000_000n)
  const api=createWASIPoll({getMemory:()=>f.memory,clockNowNs:()=>now,wait:(ms:number)=>{waits.push(ms);now+=BigInt(ms)*1_000_000n}})
  expect(api.poll_oneoff(64,1024,1,2048)).toBe(0);expect(api.sched_yield()).toBe(0)
  expect(waits).toEqual([1000,1000,500,0])
  const cancelled=createWASIPoll({getMemory:()=>f.memory,clockNowNs:()=>0n,wait:()=>{throw Error('cancelled')}})
  expect(()=>cancelled.poll_oneoff(64,1024,1,2048)).toThrow('cancelled')
  const unavailable=createWASIPoll({getMemory:()=>f.memory,clockNowNs:()=>0n})
  expect(unavailable.poll_oneoff(64,1024,1,2048)).toBe(52);expect(unavailable.sched_yield()).toBe(52)
})
test('unsupported clock IDs, flags and descriptor polling have explicit event errors',()=>{
  const f=fixture();f.subscription(0,1n,0n,0,2);f.subscription(1,2n,0n,2);f.subscription(2,3n,0n)
  f.view.setUint8(64+2*48+8,1)
  const api=createWASIPoll({getMemory:()=>f.memory,clockNowNs:()=>0n})
  expect(api.poll_oneoff(64,1024,3,2048)).toBe(0)
  expect(f.events()).toEqual([{userdata:1n,error:28,type:0},{userdata:2n,error:28,type:0},{userdata:3n,error:58,type:1}])
})

test('clock polling refreshes memory after a scheduler wait',()=>{
  const f=fixture();f.subscription(0,42n,1_000_000n)
  let now=0n
  const api=createWASIPoll({getMemory:()=>f.memory,clockNowNs:()=>now,wait:()=>{f.memory.grow(1);now=1_000_000n}})
  expect(api.poll_oneoff(64,1024,1,2048)).toBe(0)
  const view=new DataView(f.memory.buffer)
  expect(view.getUint32(2048,true)).toBe(1)
  expect(view.getBigUint64(1024,true)).toBe(42n)
  expect(view.getUint16(1032,true)).toBe(0)
})
