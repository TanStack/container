// Preview1 subscription and event records are 48 and 32 bytes respectively.
export function createWASIPoll({getMemory,clockNowNs,wait,descriptor}){
  function poll_oneoff(input,output,count,result){
    const buffer=getMemory().buffer
    const valid=(p,n)=>Number.isInteger(p)&&p>=0&&Number.isSafeInteger(n)&&n>=0&&p+n<=buffer.byteLength
    if(!Number.isInteger(count)||count<=0)return 28
    if(!valid(input,count*48)||!valid(output,count*32)||!valid(result,4))return 21
    let view=new DataView(buffer)
    const subscriptions=[]
    for(let index=0;index<count;index++){
      const p=input+index*48,userdata=view.getBigUint64(p,true),type=view.getUint8(p+8)
      const id=view.getUint32(p+16,true),timeout=view.getBigUint64(p+24,true),flags=view.getUint16(p+40,true)
      if(type>2)return 28
      if(type!==0){subscriptions.push({userdata,type,...(descriptor?descriptor(id,type):{error:58})});continue}
      if(id>1||flags>1){subscriptions.push({userdata,type,error:28});continue}
      subscriptions.push({userdata,type,id,deadline:flags===1?timeout:clockNowNs(id)+timeout})
    }
    let ready=subscriptions.filter(s=>s.type!==0||s.error!==undefined||s.deadline<=clockNowNs(s.id))
    while(!ready.length){
      const delay=subscriptions.reduce((minimum,s)=>{
        const remaining=s.deadline-clockNowNs(s.id)
        return minimum===undefined||remaining<minimum?remaining:minimum
      },undefined)
      // The injected wait parks the guest; an absent scheduler is unsupported.
      if(typeof wait!=='function')return 52
      wait(Math.min(1000,Math.max(1,Math.ceil(Number(delay)/1e6))))
      ready=subscriptions.filter(s=>s.type!==0||s.error!==undefined||s.deadline<=clockNowNs(s.id))
    }
    // A scheduler suspension may grow or replace the memory buffer.
    view=new DataView(getMemory().buffer)
    for(let index=0;index<ready.length;index++){
      const p=output+index*32,s=ready[index]
      new Uint8Array(view.buffer,p,32).fill(0)
      view.setBigUint64(p,s.userdata,true);view.setUint16(p+8,s.error??0,true);view.setUint8(p+10,s.type)
      if(s.type!==0){view.setBigUint64(p+16,s.nbytes??0n,true);view.setUint16(p+24,s.flags??0,true)}
    }
    view.setUint32(result,ready.length,true)
    return 0
  }
  return {poll_oneoff,sched_yield(){if(typeof wait!=='function')return 52;wait(0);return 0}}
}
