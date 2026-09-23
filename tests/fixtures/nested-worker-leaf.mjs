import {workerData,threadId,isMainThread} from 'node:worker_threads'
import {count,storage} from './nested-worker-state.mjs'
console.log('leaf stdout')
console.error('leaf stderr')
workerData.port.postMessage({answer:42,count,store:storage.getStore()??null,isMainThread,distinctThread:threadId!==workerData.parentThreadId})
workerData.port.close()
