import {summarize} from './structured-clone-values.mjs'
process.on('message',value=>{process.send(summarize(value));process.disconnect()})
