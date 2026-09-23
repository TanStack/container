const implementation=require('events/events.js')
const host=globalThis.__webContainerHost
module.exports=host?(host.EventEmitter??=implementation):implementation
