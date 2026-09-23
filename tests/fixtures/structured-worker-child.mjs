import {parentPort} from 'node:worker_threads'
import {summarize} from './structured-clone-values.mjs'
parentPort.on('message',({payload,port})=>{port.postMessage(summarize(payload));port.close();parentPort.close()})
