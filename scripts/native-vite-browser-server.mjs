import {existsSync,readFileSync,watch} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {syncBuiltinESMExports} from 'node:module'
import workerModule from 'node:worker_threads'

for(const key of ['NAPI_RS_ASYNC_WORK_POOL_SIZE','UV_THREADPOOL_SIZE'])if(process.env[key]!==undefined)throw Error('Unexpected pool override: '+key)
const app=process.argv[2],started=performance.now(),events=[],requests=[],hookEvents=[],protocolEvents=[]
let protocolEventsDropped=0
const recordProtocol=(creation,direction,message)=>{
 if(process.env.VITE_TRACE_WORKERS!=='1')return
 const value=message?.__emnapi__
 if(!value||!['load','loaded','start','cleanup-thread','spawn-thread','async-send'].includes(value.type))return
 if(protocolEvents.length>=96){protocolEventsDropped++;return}
 const tid=value.payload?.tid
 protocolEvents.push({creation,direction,protocol:value.type,...(Number.isInteger(tid)?{tid}:{}),atMs:performance.now()-started})
}
let server,watcher,stopping=false,workerCreations=0,active=0,peakActive=0,published=false
const metadataPath=()=>join(server?.config.cacheDir??join(app,'.vite'),'deps/_metadata.json')
const metadata=()=>{const path=metadataPath();return {path,exists:existsSync(path),...(existsSync(path)?{contents:readFileSync(path,'utf8').slice(0,8192)}:{})}}
const beforeCache=metadata(),OriginalWorker=workerModule.Worker
const send=value=>{if(process.connected)process.send(value)}
workerModule.Worker=class extends OriginalWorker{
 constructor(...args){const id=++workerCreations;if(events.length<96)events.push({phase:'create',id,ms:performance.now()-started});super(...args);this.traceCreation=id;active++;peakActive=Math.max(peakActive,active);if(process.env.VITE_TRACE_WORKERS==='1')this.on('message',message=>recordProtocol(id,'receive',message));this.once('exit',code=>{active--;if(events.length<96)events.push({phase:'exit',id,code,ms:performance.now()-started})})}
 postMessage(message,...args){recordProtocol(this.traceCreation,'send',message);return super.postMessage(message,...args)}
}
syncBuiltinESMExports()
const stop=async failure=>{
 if(stopping)return
 stopping=true;watcher?.close()
 try{await server?.close()}catch(error){failure??=String(error.stack??error)}
 clearTimeout(deadline)
 const result={failure,beforeCache,afterCache:metadata(),workerCreations,active,peakActive,events,requests,hookEvents,protocolEvents,protocolEventsDropped,elapsedMs:performance.now()-started}
 if(process.connected)process.send({type:'result',result},()=>process.exit(failure?1:0));else process.exit(failure?1:0)
}
const deadline=setTimeout(()=>{void stop('15-second native round deadline')},15000)
process.on('message',message=>{if(message?.type==='stop')void stop()})
try{
 const fixture=fileURLToPath(new URL('../fixtures/vite-rolldown-wasm',import.meta.url))
 const {createServer}=await import(pathToFileURL(join(fixture,'node_modules/vite/dist/node/index.js')).href)
 server=await createServer({root:app,configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0,strictPort:true}})
 if(process.env.VITE_TRACE_HOOKS==='1'){
  let hookCalls=0;const hookStarted=performance.now()
  const emitHook=row=>{if(hookEvents.length<96)hookEvents.push({...row,atMs:performance.now()-hookStarted})}
  // Match the guest's opt-in observer. Durations include async waits, not just CPU.
  for(const plugin of server.config.plugins)for(const name of ['load','transform']){
   const original=plugin[name],handler=typeof original==='function'?original:original?.handler
   if(typeof handler!=='function')continue
   const wrapped=function(...args){
    const row={call:++hookCalls,plugin:String(plugin.name).slice(0,80),hook:name,id:String(args[name==='transform'?1:0]).slice(0,120)}
    emitHook({...row,phase:'begin'})
    try{
     const result=handler.apply(this,args)
     if(result&&typeof result.then==='function')result.then(()=>emitHook({...row,phase:'end'}),error=>emitHook({...row,phase:'error',message:String(error).slice(0,160)}))
     else emitHook({...row,phase:'end'})
     return result
    }catch(error){emitHook({...row,phase:'error',message:String(error).slice(0,160)});throw error}
   }
   plugin[name]=typeof original==='function'?wrapped:{...original,handler:wrapped}
  }
 }
 const check=()=>{if(!published&&metadata().exists){published=true;send({type:'cache-published',ms:performance.now()-started})}}
 watcher=watch(app,{recursive:true},check);check()
 server.httpServer.prependListener('request',(req,res)=>{if(requests.length<96){const entry={path:String(req.url).slice(0,300),ms:performance.now()-started};requests.push(entry);res.once('finish',()=>{entry.status=res.statusCode;entry.finishedMs=performance.now()-started})}})
 await server.listen()
 send({type:'ready',url:'http://127.0.0.1:'+server.httpServer.address().port})
}catch(error){await stop(String(error.stack??error))}
