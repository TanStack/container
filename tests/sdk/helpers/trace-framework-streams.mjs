/** Passive, bounded guest diagnostics. Never attaches listeners or reads data. */
export function traceFrameworkStreams(fs,log=line=>console.log(line)){
  const prototype=fs.ReadStream?.prototype
  if(!prototype)return
  const streams=new WeakMap()
  let streamCount=0,observations=0
  const identify=stream=>{
    if(streams.has(stream))return streams.get(stream)
    if(streamCount>=16||typeof stream.path!=='string'||!stream.path.includes('/.vite/'))return
    const entry={streamId:++streamCount,path:stream.path.slice(0,1024)}
    streams.set(stream,entry)
    return entry
  }
  const observe=(stream,phase)=>{
    try{
      if(observations>=128)return
      const entry=identify(stream)
      if(!entry)return
      const row={...entry,sequence:++observations,phase}
      const copy=(target,source,keys)=>{
        for(const key of keys){
          const value=source?.[key]
          if(value===null||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))target[key]=value
        }
      }
      copy(row,stream,['bytesRead','readableLength','readableFlowing','readable','readableEnded','destroyed','closed','pending','fd'])
      row.readableState={}
      copy(row.readableState,stream._readableState,['length','flowing','reading','constructed','constructing','sync','ended','endEmitted','destroyed','closed','closeEmitted','needReadable','emittedReadable','readingMore','awaitDrainWriters','highWaterMark'])
      log('FRAMEWORK_STREAM_TRACE '+JSON.stringify(row))
    }catch{}
  }
  const construct=prototype._construct,read=prototype._read,emit=prototype.emit
  if(typeof construct==='function')prototype._construct=function(...args){
    observe(this,'construct-enter')
    let tracked=false
    try{tracked=streams.has(this)}catch{}
    if(tracked&&typeof args[0]==='function'){
      const callback=args[0],stream=this
      args[0]=function(...callbackArgs){
        observe(stream,'construct-callback')
        return Reflect.apply(callback,this,callbackArgs)
      }
    }
    return Reflect.apply(construct,this,args)
  }
  if(typeof read==='function')prototype._read=function(...args){
    observe(this,'read-enter')
    return Reflect.apply(read,this,args)
  }
  if(typeof emit==='function')prototype.emit=function(...args){
    if(['open','ready','end','close','error','readable'].includes(args[0]))observe(this,'emit-'+args[0])
    return Reflect.apply(emit,this,args)
  }
}

export const guestStreamTracePrelude=`import * as __frameworkStreamTraceFs from 'node:fs';\n(${traceFrameworkStreams.toString()})(__frameworkStreamTraceFs);\n`
