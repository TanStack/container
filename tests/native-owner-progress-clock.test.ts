import {expect,test,vi} from 'vitest'
import {NativeOwnerClient} from '../src/native/owner-transport'

test('owner progress history stays on one client clock across restore and replacement workers',async()=>{
  let channel:any,now=100
  const clock=vi.spyOn(performance,'now').mockImplementation(()=>now)
  vi.stubGlobal('location',new URL('https://app.test/'))
  vi.stubGlobal('MessageChannel',class{
    port1={onmessage:undefined as any,start:vi.fn(),close:vi.fn(),postMessage:vi.fn()}
    port2={}
    constructor(){channel=this}
  })
  const frame={postMessage:()=>channel.port1.onmessage({data:{protocol:'native-owner-v1',type:'connected'}})} as unknown as Window
  let client:NativeOwnerClient|undefined
  try{
    client=await NativeOwnerClient.connect(frame,'https://owner.test')
    const events:any[]=[]
    client.subscribeEvents(event=>events.push(event))
    const restore={type:'progress',phase:'restore-checkpoint-loading',elapsedMs:0}
    const replacement={type:'progress',phase:'worker:1:binding-ready'}
    const response={type:'progress',phase:'host-start-response-received',elapsedMs:3,durationMs:42}
    for(const [time,event]of [[125,restore],[175,replacement],[200,response]] as const){
      now=time;channel.port1.onmessage({data:{protocol:'native-owner-v1',type:'event',event}})
    }
    expect(events.map(event=>event.elapsedMs)).toEqual([25,75,100])
    expect(client.events).toEqual(events)
    expect(events[2].durationMs).toBe(42)
    expect(response.durationMs).toBe(42)
    expect(restore.elapsedMs).toBe(0);expect(replacement).not.toHaveProperty('elapsedMs');expect(response.elapsedMs).toBe(3)
    const diagnostic={type:'diagnostic',error:'original failure',stack:'original stack'}
    channel.port1.onmessage({data:{protocol:'native-owner-v1',type:'event',event:diagnostic}})
    expect(events.at(-1)).toBe(diagnostic)
    expect(client.events.at(-1)).toBe(diagnostic)
    const output={type:'output',stream:'stdout',text:'unchanged output'}
    channel.port1.onmessage({data:{protocol:'native-owner-v1',type:'event',event:output}})
    expect(events.at(-1)).toBe(output)
    expect(client.events.at(-1)).toBe(output)
  }finally{client?.close();clock.mockRestore();vi.unstubAllGlobals()}
})
