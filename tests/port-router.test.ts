import {it,expect} from 'vitest'
import {PortRouter} from '../src/sandbox/port-router'
import {spawnSync} from 'node:child_process'
it('keeps message resources through endpoint movement until receiver acknowledgement',async()=>{
 const router=new PortRouter(),[a,b]=router.pair(1)
 let releases=0
 router.send(1,a,new Uint8Array([42]),[],[{dispose(){releases++}}])
 const first=await router.receive(1,b)
 router.move(1,2,[b]);expect(releases).toBe(0)
 expect(router.takeDelivery(2,b)).toEqual(first)
 router.ack(2,b,first!.token);expect(releases).toBe(1)
 router.release(1);router.release(2);expect(releases).toBe(1)
})
it('drops in-flight message resources when the receiver exits before acknowledging',async()=>{
 const router=new PortRouter(),[a,b]=router.pair(1)
 router.move(1,2,[b]);let releases=0
 const waiting=router.receive(2,b)
 router.send(1,a,new Uint8Array([42]),[],[{dispose(){releases++}}])
 await waiting;expect(releases).toBe(0)
 router.release(2);expect(releases).toBe(1)
 router.release(1);expect(releases).toBe(1)
})
it('moves a queued endpoint to one owner and invalidates the sender',async()=>{
 const router=new PortRouter(),[a,b]=router.pair(1)
 router.send(1,a,new Uint8Array([42]));router.move(1,2,[b])
 expect(()=>router.take(1,b)).toThrow(/belongs/)
 const first=await router.receive(2,b);expect(first?.bytes).toEqual(new Uint8Array([42]))
 router.send(2,b,new Uint8Array([7]));expect(router.take(1,a)).toEqual(new Uint8Array([7]))
 router.close(2,b);expect(await router.receive(1,a)).toBeNull()
})
it('replays an unacknowledged delivery after a started endpoint moves',async()=>{
 const router=new PortRouter(),[a,b]=router.pair(1)
 const pending=router.receive(1,b);router.send(1,a,new Uint8Array([42]))
 const delivered=await pending;expect(delivered?.bytes).toEqual(new Uint8Array([42]))
 router.move(1,2,[b])
 const replayed=await router.receive(2,b);expect(replayed).toEqual(delivered)
 router.ack(2,b,replayed!.token)
 const waiting=router.receive(2,b);router.send(1,a,new Uint8Array([7]))
 expect((await waiting)?.bytes).toEqual(new Uint8Array([7]))
})
it('does not move transferred endpoints when the destination queue rejects',()=>{
 const router=new PortRouter(),[a,b]=router.pair(1),[,transfer]=router.pair(1)
 router.move(1,2,[b])
 for(let i=0;i<256;i++)router.send(1,a,new Uint8Array([1]))
 expect(()=>router.send(1,a,new Uint8Array([1]),[transfer])).toThrow(/full/)
 expect(()=>router.validate(1,[transfer])).not.toThrow()
 expect(()=>router.validate(2,[transfer])).toThrow()
})
it('bounds endpoints and rejects duplicate ownership moves',()=>{
 const router=new PortRouter(),[a]=router.pair(1)
 expect(()=>router.move(1,2,[a,a])).toThrow()
 for(let i=1;i<256;i++)router.pair(1)
 expect(()=>router.pair(1)).toThrow(/limit/)
 router.release(1);expect(()=>router.pair(2)).not.toThrow()
})
it('native Node retains queued messages through Worker bootstrap and postMessage transfers',()=>{
 const run=spawnSync(process.execPath,['tests/fixtures/worker-port-parent.mjs'],{encoding:'utf8',timeout:15000})
 expect(run.status,run.stderr).toBe(0)
 expect(JSON.parse(run.stdout)).toEqual([{mode:'bootstrap',value:42,code:0},{mode:'postMessage',value:42,code:0},{mode:'started',value:42,code:0}])
})
