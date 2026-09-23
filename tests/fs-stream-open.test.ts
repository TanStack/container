import {readFileSync} from 'node:fs'
import {describe,it,expect} from 'vitest'

const source=readFileSync(new URL('../src/sandbox/guest-fs-streams.js',import.meta.url),'utf8').replaceAll('export ','')
describe('filesystem stream open',()=>{
  for(const name of ['ReadStream','WriteStream'])it(name+' waits for async open before open, ready and construction completion',()=>{
    const events:unknown[]=[];let finish!:(error:Error|null,fd?:number)=>void
    class Stream {
      _writableState={autoDestroy:true}
      emit(event:string,...args:unknown[]){events.push([event,...args])}
    }
    const types=new Function('Readable','Writable','filePath','open',source+';return {ReadStream,WriteStream}')(Stream,Stream,(path:string)=>path,(_path:string,_flags:string,_mode:number,callback:typeof finish)=>{finish=callback})
    const stream=new types[name]('/value')
    stream._construct((error?:Error)=>events.push(['constructed',error]))
    expect(events).toEqual([]);expect(stream.fd).toBeNull()
    finish(null,42)
    expect(events).toEqual([['open',42],['ready'],['constructed',undefined]])
    expect(stream.fd).toBe(42)
  })
})
