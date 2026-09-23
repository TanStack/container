const implementation=require('readable-stream/lib/stream.js')

// Web API and builtin bundles execute in the same guest but have separate module
// caches. Keep one stream constructor family, regardless of bundle load order.
const key=Symbol.for('web-container:node-stream')
const stream=globalThis[key]??=implementation
module.exports=stream
