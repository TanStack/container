import {describe,it,expect} from 'vitest'
import {FetchEntryHandler} from '../src/native/fetch-entry-handler'

describe('fetch entry publication',()=>{
  it('does not cancel a streaming response when the handler changes',async()=>{
    let controller!:ReadableStreamDefaultController<Uint8Array>
    const encoder=new TextEncoder()
    const handler=new FetchEntryHandler({fetch:()=>new Response(new ReadableStream<Uint8Array>({start(value){controller=value}}))})
    const response=await handler.fetch(new Request('http://app/'))
    const reader=response.body!.getReader()
    controller.enqueue(encoder.encode('first'))
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
    handler.replace({fetch:()=>new Response('new')})
    controller.enqueue(encoder.encode('last'))
    controller.close()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('last')
    expect((await reader.read()).done).toBe(true)
    expect(await (await handler.fetch(new Request('http://app/'))).text()).toBe('new')
  })
  it('validates before publication and can restore the prior handler',async()=>{
    const handler=new FetchEntryHandler({default:{fetch:()=>new Response('old')}})
    expect(()=>handler.replace({default:{}})).toThrow('does not export a fetch handler')
    expect(await (await handler.fetch(new Request('http://app/'))).text()).toBe('old')
    const restore=handler.replace({fetch:()=>new Response('new')})
    expect(await (await handler.fetch(new Request('http://app/'))).text()).toBe('new')
    restore()
    expect(await (await handler.fetch(new Request('http://app/'))).text()).toBe('old')
  })
  it('keeps an in-flight request on its original handler',async()=>{
    let finish!:(response:Response)=>void
    const handler=new FetchEntryHandler({default:()=>new Promise<Response>(resolve=>{finish=resolve})})
    const pending=handler.fetch(new Request('http://app/'))
    handler.replace({fetch:()=>new Response('new')})
    finish(new Response('old'))
    expect(await (await pending).text()).toBe('old')
    expect(await (await handler.fetch(new Request('http://app/'))).text()).toBe('new')
  })
})
