import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

// Node 24.15.0's end-of-stream check also waits for pending write callbacks.
// readable-stream 4.7.0 otherwise resolves finished() early for an ended stream
// with autoDestroy:false, even while its queued write or finalizer is pending.
export function stageStreamFinished(source){
  if(createHash('sha256').update(source).digest('hex')!=='0913841412f20ba752fb764e41007e660677012e0ec619faefac063776eba08c')throw Error('readable-stream end-of-stream source changed')
  const marker='    (writableFinished || isWritable(stream) === false)\n'
  if(source.split(marker).length!==2)throw Error('Stream completion patch boundary changed')
  return source.replace(marker,'    (writableFinished || isWritable(stream) === false) &&\n    (wState == null || wState.pendingcb === undefined || wState.pendingcb === 0)\n')
}

export const streamFinishedPlugin=()=>({name:'guest-stream-finished',setup(build){
  build.onLoad({filter:/readable-stream\/lib\/internal\/streams\/end-of-stream\.js$/},args=>{
    if(args.path!==resolve('node_modules/readable-stream/lib/internal/streams/end-of-stream.js'))return
    return {contents:stageStreamFinished(readFileSync(args.path,'utf8')),loader:'js'}
  })
}})
