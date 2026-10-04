import streamsLibrary,{Readable} from 'readable-stream'

export async function pipeline(...streams:unknown[]):Promise<unknown>{
  if(streams.length<2)throw Error('pipeline requires at least two streams')
  let cleanup=Promise.resolve()
  let adapted:InstanceType<typeof Readable>|undefined
  if(streams[0] instanceof ReadableStream){
    const source=streams[0] as ReadableStream<Uint8Array>
    const reader=source.getReader()
    let released!:()=>void
    cleanup=new Promise<void>(resolve=>{released=resolve})
    let reading=false
    const readable=new Readable({autoDestroy:true,
      read(){
        if(reading)return
        reading=true
        void reader.read().then(({done,value})=>{
          reading=false
          if(!this.destroyed)this.push(done?null:value)
        },error=>this.destroy(error))
      },
      destroy(error:Error|null,callback:(error?:Error|null)=>void){
        void reader.cancel(error).then(()=>{reader.releaseLock();released();callback(error)},cause=>{
          reader.releaseLock();released();callback(error??cause)
        })
      },
    })
    adapted=readable
    streams[0]=readable
  }
  try{return await streamsLibrary.promises.pipeline(...streams)}
  catch(error){if(adapted&&!adapted.destroyed)adapted.destroy();throw error}
  finally{await cleanup}
}

export function finished(stream:unknown,options?:unknown):Promise<void>{
  return streamsLibrary.promises.finished(stream,options)
}

export default {pipeline,finished}
