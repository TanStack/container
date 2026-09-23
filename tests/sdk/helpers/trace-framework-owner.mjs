import {readFileSync} from 'node:fs'

// Diagnostic-only instrumentation of the copied example, never shipped SDK code.
export function traceFrameworkOwner(source){
  const target='server:new WorkerHTTP(session.kernel,port)'
  if(source.split(target).length!==2)throw Error('Unexpected framework owner trace integration site')
  const instrumentation=`
const ownerTrace=globalThis.__frameworkOwnerTrace={requests:[]};
const traceHTTP=(kernel,port)=>({async fetch(request){
  const row={url:request.url,started:performance.now(),stage:'connect',reads:0,bytes:0};
  const optimized=request.url.includes('/.vite/');
  const observe=(operation,complete,failed)=>{try{const promise=operation();promise.then(complete,failed);return promise}catch(error){failed(error);throw error}};
  if(ownerTrace.requests.length<512)ownerTrace.requests.push(row);
  const transport={async connect(...args){
    const socket=await kernel.connect(...args);
    row.stage='connected';
    return {
      async write(...args){row.stage='write';const result=await socket.write(...args);row.stage='written';return result},
      async read(...args){row.stage='read';const result=await socket.read(...args);row.reads++;row.bytes+=result?.bytes?.byteLength??0;if(row.url.includes('/.vite/')&&result?.bytes){if(row.reads===1)row.wirePrefix=new TextDecoder().decode(result.bytes.slice(0,1024));row.wireTail=new TextDecoder().decode(result.bytes.slice(-128))}row.stage='read-'+(result?.type??'null');return result},
      close(...args){row.closed=performance.now();if(!optimized)return socket.close(...args);row.closeStarted=row.closed;return observe(()=>socket.close(...args),()=>{row.closeSettled=performance.now()},error=>{row.closeError=String(error);row.closeSettled=performance.now()})},
    };
  }};
  try{const response=await new WorkerHTTP(transport,port).fetch(request);row.headersAt=performance.now();row.status=response.status;row.headers=Object.fromEntries(response.headers);
    if(optimized){
      const arrayBuffer=response.arrayBuffer;
      response.arrayBuffer=function(...args){row.bodyStarted=performance.now();return observe(()=>arrayBuffer.apply(this,args),()=>{row.bodyDone=performance.now();row.bodyCompletion='arrayBuffer'},error=>{row.bodyError=String(error)})};
      if(response.body){const getReader=response.body.getReader;response.body.getReader=function(...args){const reader=getReader.apply(this,args),read=reader.read;reader.read=function(...args){return observe(()=>read.apply(this,args),result=>{if(result.done){row.bodyReaderDone=performance.now();row.bodyDone=row.bodyReaderDone;row.bodyCompletion='reader'}},error=>{row.bodyError=String(error)})};return reader}}
    }
    return response}
  catch(error){row.error=String(error);throw error}
}});
ownerTrace.resources=()=>session?.kernel.resources();
ownerTrace.optimizer=()=>traceOptimizerFiles(session.kernel,{maxHashBytes:0});
`
  const optimizer=readFileSync(new URL('./trace-optimizer-files.mjs',import.meta.url),'utf8').replace('export async function traceOptimizerFiles','async function traceOptimizerFiles')
  return source.replace(target,'server:traceHTTP(session.kernel,port)')+instrumentation+optimizer
}
