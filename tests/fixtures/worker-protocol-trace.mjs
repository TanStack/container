// Diagnostic only. Record protocol names and thread IDs, never message bodies.
export function traceWorkerProtocol(workerModule,emit,limit=96,types,observe){
  const Base=workerModule.Worker,ids=new WeakMap();let next=0,count=0
  const record=(worker,direction,message)=>{
    const protocol=message?.__emnapi__
    if(!protocol||typeof protocol.type!=='string')return
    if(types&&!types.includes(protocol.type))return
    const tid=protocol.payload?.tid
    const row={worker:ids.get(worker),direction,type:protocol.type,...(Number.isInteger(tid)?{tid}:{})}
    observe?.(row)
    if(count>=limit)return
    count++
    emit(row)
  }
  workerModule.Worker=class extends Base{
    constructor(...args){super(...args);ids.set(this,++next);this.on('message',message=>record(this,'receive',message))}
    postMessage(message,...args){record(this,'send',message);return super.postMessage(message,...args)}
  }
}
