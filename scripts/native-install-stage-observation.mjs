import {safariInstallStageTraceSource} from './safari-install-stage-trace.mjs'
import {installNativeInstallFilesystemObservation} from './native-install-filesystem-observation.mjs'

// Diagnostic only. Keep progress and RPC messages untouched, log timing data
// without package names, URLs, file contents or results.
export function installNativeInstallStageSummary(){
  const post=self.postMessage,pending=new Map(),stages={}
  let limited=false,lastCompleted=0
  const summary=()=>{
    const now=performance.now(),pendingStages={}
    for(const begin of pending.values()){
      const row=pendingStages[begin.stage]??={count:0,maxAgeMs:0}
      row.count++;row.maxAgeMs=Math.max(row.maxAgeMs,now-begin.at)
    }
    console.info('INSTALL_PHASE_SUMMARY '+JSON.stringify({stages,pending:pending.size,pendingStages,limited}))
  }
  self.postMessage=function(message,...args){
    if(message?.type==='sandbox-install-stage'&&message.channel==='phase'){
      if(message.state==='limit')limited=true
      else if(message.state==='begin')pending.set(message.traceId,message)
      else {
        const begin=pending.get(message.traceId)
        if(begin){
          pending.delete(message.traceId)
          const row=stages[begin.stage]??={count:0,totalMs:0,maxMs:0,errors:0}
          const ms=message.at-begin.at
          row.count++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms)
          if(message.state==='error')row.errors++
        }
      }
    }
    if(message?.type==='native-dev-progress'){
      const match=/^dependency-installed:(\d+)\/\d+$/.exec(message.phase)
      const completed=match?Number(match[1]):0
      if(message.phase==='dependencies-installed'||completed>=lastCompleted+20){
        lastCompleted=completed
        try{summary()}catch{}
      }
    }
    return Reflect.apply(post,this,[message,...args])
  }
}

const summarySource=`(${installNativeInstallStageSummary.toString()})();\n`
const filesystemSource=`(${installNativeInstallFilesystemObservation.toString()})();\n`

export function nativeInstallTraceResponse(path,bytes,workerPaths,enabled){
  // Exact catalog paths, not a broad match that could instrument a child or
  // compiler worker. Disabled observation returns the original buffer.
  return enabled&&workerPaths.has(path)
    ?summarySource+filesystemSource+safariInstallStageTraceSource+bytes.toString('utf8'):bytes
}
