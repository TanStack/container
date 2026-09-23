// Node and Web streams stay inside the guest. These adapters transfer chunks
// and cancellation, never host stream objects or browser capabilities.
export function installWebStreamAdapters(Stream) {
  const {Readable,Writable,Duplex}=Stream
  const invalid=message=>Object.assign(new TypeError(message),{code:'ERR_INVALID_ARG_TYPE'})
  const premature=()=>Object.assign(Error('Premature close'),{code:'ERR_STREAM_PREMATURE_CLOSE'})
  const webError=error=>error?.code==='ERR_STREAM_PREMATURE_CLOSE'
    ?Object.assign(new Error('The operation was aborted',{cause:error}),{name:'AbortError',code:'ABORT_ERR'})
    :error
  function webType(name,value){
    const type=globalThis[name]
    if(!type)throw Object.assign(Error(name+' is unavailable in this backend'),{code:'ERR_UNSUPPORTED_OPERATION'})
    if(value!==undefined&&!(value instanceof type))throw invalid('Expected '+name)
    return type
  }
  Readable.fromWeb=(source,options={})=>{
    webType('ReadableStream',source)
    const reader=source.getReader()
    // Node retains the reader lock for the lifetime of its adapter.
    let reading=false,ended=false
    const stream=new Readable({...options,read(){
      if(reading||ended)return
      reading=true
      reader.read().then(({done,value})=>{
        reading=false
        if(stream.destroyed)return
        if(done){ended=true;stream.push(null)}else stream.push(value)
      },error=>{reading=false;stream.destroy(error)})
    },destroy(error,done){
      if(ended){done(error);return}
      reader.cancel(error).then(()=>{ended=true;done(error)},failure=>{ended=true;done(error??failure)})
    }})
    reader.closed.catch(error=>{if(!ended&&!stream.destroyed)stream.destroy(error)})
    return stream
  }
  Readable.toWeb=(source,options={})=>{
    const WebReadable=webType('ReadableStream')
    if(!(source instanceof Readable))throw invalid('Expected a Node Readable')
    let terminal=false,canceled=false
    let cleanup=()=>{}
    return new WebReadable({
      start(controller){
        const data=chunk=>{
          if(terminal)return
          controller.enqueue(!source.readableObjectMode&&chunk instanceof Uint8Array?new Uint8Array(chunk):chunk)
          if(controller.desiredSize<=0)source.pause()
        }
        const end=()=>{if(!terminal){terminal=true;controller.close()}cleanup()}
        const error=reason=>{if(!terminal){terminal=true;controller.error(webError(reason))}}
        const close=()=>{if(!terminal&&!canceled)error(source.errored??premature());cleanup()}
        cleanup=()=>{source.off('data',data);source.off('end',end);source.off('error',error);source.off('close',close)}
        source.on('data',data);source.on('end',end);source.on('error',error);source.on('close',close);source.pause()
        if(source.readableEnded)end();else if(source.destroyed)close()
      },
      pull(){source.resume()},
      cancel(reason){
        canceled=true;terminal=true
        if(source.closed){cleanup();return}
        return new Promise(resolve=>{source.once('close',resolve);source.destroy(reason)})
      },
    },options.strategy??{highWaterMark:source.readableHighWaterMark,
      ...(source.readableObjectMode?{}:{size:chunk=>chunk.byteLength})})
  }
  Writable.fromWeb=(destination,options={})=>{
    webType('WritableStream',destination)
    const writer=destination.getWriter()
    let ended=false
    const stream=new Writable({...options,
      write(chunk,_encoding,done){writer.write(chunk).then(()=>done(),done)},
      final(done){writer.close().then(()=>{ended=true;done()},done)},
      destroy(error,done){
        if(ended){done(error);return}
        writer.abort(error).then(()=>{ended=true;done(error)},failure=>{ended=true;done(error??failure)})
      },
    })
    writer.closed.catch(error=>{if(!ended&&!stream.destroyed)stream.destroy(error)})
    return stream
  }
  Writable.toWeb=destination=>{
    const WebWritable=webType('WritableStream')
    if(!(destination instanceof Writable))throw invalid('Expected a Node Writable')
    let canceled=false
    return new WebWritable({
      start(controller){
        const error=reason=>controller.error(webError(reason))
        const close=()=>{
          if(!destination.writableFinished&&!canceled)controller.error(webError(destination.errored??premature()))
          destination.off('error',error);destination.off('close',close)
        }
        destination.on('error',error);destination.on('close',close)
        if(destination.destroyed)close()
      },
      write(chunk){return new Promise((resolve,reject)=>destination.write(chunk,error=>error?reject(error):resolve()))},
      close(){return new Promise((resolve,reject)=>destination.end(error=>error?reject(error):resolve()))},
      abort(reason){
        canceled=true
        if(destination.closed)return
        return new Promise(resolve=>{destination.once('close',resolve);destination.destroy(reason)})
      },
    },{highWaterMark:destination.writableHighWaterMark})
  }
  Duplex.fromWeb=(pair,options={})=>{
    if(!pair||typeof pair!=='object')throw invalid('Expected readable/writable pair')
    webType('ReadableStream',pair.readable);webType('WritableStream',pair.writable)
    // Own the pair directly. Duplex.from({readable,writable}) adds a second
    // stream layer that loses options and turns a clean destroy into an abort.
    const writer=pair.writable.getWriter(),reader=pair.readable.getReader()
    let readableClosed=false,writableClosed=false,reading=false
    const stream=new Duplex({
      ...options,allowHalfOpen:options.allowHalfOpen??false,
      read(){
        if(reading)return
        reading=true
        reader.read().then(({done,value})=>{
          reading=false
          if(!stream.destroyed)stream.push(done?null:value)
        },error=>{reading=false;stream.destroy(error)})
      },
      write(chunk,_encoding,done){writer.ready.then(()=>writer.write(chunk)).then(()=>done(),done)},
      final(done){
        if(writableClosed){done();return}
        writer.close().then(()=>done(),done)
      },
      destroy(error,done){
        Promise.all([
          writableClosed?undefined:writer.abort(error),
          readableClosed?undefined:reader.cancel(error),
        ]).then(()=>done(error),()=>done(error))
      },
    })
    writer.closed.then(()=>{
      writableClosed=true
      if(!stream.writableEnded)stream.destroy(premature())
    },error=>{writableClosed=true;readableClosed=true;stream.destroy(error)})
    reader.closed.then(()=>{readableClosed=true},error=>{
      writableClosed=true;readableClosed=true;stream.destroy(error)
    })
    return stream
  }
  Duplex.toWeb=duplex=>{
    if(!(duplex instanceof Duplex))throw invalid('Expected a Node Duplex')
    return {readable:Readable.toWeb(duplex),writable:Writable.toWeb(duplex)}
  }
}
