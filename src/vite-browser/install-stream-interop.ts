import {Readable} from 'stream-browserify'

type NodeReadable=typeof Readable&{
  toWeb?:(stream:InstanceType<typeof Readable>)=>ReadableStream<Uint8Array>
  fromWeb?:(stream:ReadableStream<Uint8Array>)=>InstanceType<typeof Readable>
}

const nodeReadable=Readable as NodeReadable

// stream-browserify's older readable-stream has the event state but not the
// public Node getter. Consumers must be able to observe an already-ended stream
// before attaching an end listener, otherwise shutdown waits can miss the event.
if(!Object.getOwnPropertyDescriptor(Readable.prototype,'readableEnded')){
  Object.defineProperty(Readable.prototype,'readableEnded',{
    configurable:true,
    get(this:{_readableState?:{endEmitted?:boolean}}){return this._readableState?.endEmitted===true},
  })
}

nodeReadable.toWeb??=(stream:InstanceType<typeof Readable>)=>new ReadableStream<Uint8Array>({
  start(controller){
    stream.pause()
    stream.on('data',(chunk:Uint8Array|string)=>{
      controller.enqueue(typeof chunk==='string'?new TextEncoder().encode(chunk):new Uint8Array(chunk))
      if((controller.desiredSize??0)<=0)stream.pause()
    })
    stream.once('end',()=>controller.close())
    stream.once('error',(error:Error)=>controller.error(error))
  },
  pull(){stream.resume()},
  cancel(){stream.destroy()},
})

nodeReadable.fromWeb??=(stream:ReadableStream<Uint8Array>)=>{
  const reader=stream.getReader()
  let reading=false
  return new Readable({
    read(){
      if(reading)return
      reading=true
      void reader.read().then(({done,value}:{done:boolean;value?:Uint8Array})=>{
        reading=false
        this.push(done?null:Buffer.from(value!))
      },(error:Error)=>this.destroy(error))
    },
    destroy(error:Error|null,callback:(error?:Error|null)=>void){void reader.cancel().finally(()=>callback(error))},
  })
}
