const EventEmitter=require('./shared-events.cjs')
const getGuestProcess=require('./guest-process-state.cjs')
module.exports=getGuestProcess(EventEmitter)
