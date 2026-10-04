import {expect,test} from 'vitest'
import {PassThrough} from 'stream-browserify'
import {PassThrough as NodePassThrough} from 'node:stream'
import '../src/vite-browser/install-stream-interop'

test('readableEnded reflects emitted end, including streams observed after end',async()=>{
  for(const Stream of [PassThrough,NodePassThrough]){
    const stream=new Stream() as InstanceType<typeof NodePassThrough>
    expect(stream.readableEnded).toBe(false)
    const ended=new Promise<void>(resolve=>stream.once('end',resolve))
    stream.end('output')
    expect(stream.readableEnded).toBe(false)
    stream.resume()
    await ended
    expect(stream.readableEnded).toBe(true)
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(stream.readableEnded).toBe(true)
  }
})
