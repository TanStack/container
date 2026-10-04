import type {AgentProcessHandle} from '../sdk/agent-session-core'
import type {ProcessEvent} from '../sandbox/guest-processes'
import {runNativeAgentCommand,type NativeAgentCommandBackend,type NativeAgentInput} from './agent-command'

/** A streamed native command, with bounded unread output and acknowledged cleanup. */
export function spawnNativeAgentProcess(backend:NativeAgentCommandBackend,
  input:{command:string;args?:string[];cwd:string;env?:Record<string,string>},options:{maxQueuedBytes?:number;stdin?:'pipe'}={}):AgentProcessHandle {
  const limit=options.maxQueuedBytes??1024*1024
  if(!Number.isSafeInteger(limit)||limit<1||limit>16*1024*1024)throw Error('Invalid native process output queue limit')
  const controller=new AbortController(),queue:ProcessEvent[]=[]
  let queuedBytes=0,settled=false,disposed=false,failure:unknown,wake:(()=>void)|undefined
  const cancellation=new DOMException('Native agent process cancelled','AbortError')
  let inputPipe:NativeAgentInput|undefined,inputEnded=false
  const notify=()=>{const current=wake;wake=undefined;current?.()}
  const completion=runNativeAgentCommand(backend,input,{signal:controller.signal,maxOutputBytes:1,
    ...(options.stdin==='pipe'?{onInput:(pipe:NativeAgentInput)=>{inputPipe=pipe}}:{}),onOutput:(text,stream)=>{
    if(disposed||failure||!text)return
    const bytes=new TextEncoder().encode(text)
    if(queuedBytes+bytes.length>limit||queue.length>=4096){
      failure=Object.assign(Error('Native process unread output limit exceeded'),{code:'ERR_OUTPUT_LIMIT'})
      controller.abort(failure);notify();return
    }
    queue.push({type:stream,bytes});queuedBytes+=bytes.length;notify()
  }}).then(result=>{
    if(failure)throw failure
    if(!disposed)queue.push({type:'exit',code:result.status,signal:null})
    return {exitCode:result.status,signal:null}
  }).catch(error=>{failure??=error;throw failure}).finally(()=>{settled=true;notify()})
  void completion.catch(()=>{})
  let reading=false,disposing:Promise<void>|undefined
  const stop=async()=>{
    if(settled)return false
    controller.abort(cancellation)
    try{await completion}catch(error){if(error!==cancellation&&(error as Error)?.name!=='AbortError')throw error}
    return true
  }
  return {
    ...(options.stdin==='pipe'?{
      writeInput:async(value:string|Uint8Array)=>{
        if(disposed||settled||inputEnded||controller.signal.aborted)throw Error('Native agent input is closed')
        if(!inputPipe)throw Error('Native agent input is unavailable')
        if(inputPipe.writeInputAcknowledged)await inputPipe.writeInputAcknowledged(value)
        else inputPipe.writeInput(value)
      },
      endInput:async()=>{
        if(disposed||settled||controller.signal.aborted)throw Error('Native agent input is closed')
        if(inputEnded)return
        if(!inputPipe)throw Error('Native agent input is unavailable')
        inputEnded=true;inputPipe.endInput()
      },
    }:{}),
    next:async()=>{
      if(reading)throw Error('Concurrent native process reads are not supported')
      reading=true
      try{
        for(;;){
          if(disposed)return null
          if(failure)throw failure
          const event=queue.shift()
          if(event){if(event.type==='stdout'||event.type==='stderr')queuedBytes-=event.bytes.length;return event}
          if(settled)return null
          await new Promise<void>(resolve=>{wake=resolve})
        }
      }finally{reading=false}
    },
    wait:()=>completion,
    kill:async(signal='SIGKILL')=>{
      if(signal!=='SIGKILL')throw Object.assign(Error('Native agent process supports SIGKILL cancellation only'),{code:'ERR_UNSUPPORTED_OPERATION'})
      return stop()
    },
    dispose:()=>disposing??=(async()=>{disposed=true;queue.length=0;queuedBytes=0;notify();await stop()})(),
  }
}
