import ProbeWorker from './cooperative-interrupt.worker?worker'

export async function probeCooperativeWorker(wasm=false){
  const worker=new ProbeWorker()
  let cancelTimer:ReturnType<typeof setTimeout>|undefined
  let deadline:ReturnType<typeof setTimeout>|undefined
  let cancelSentAt=0
  try{
    return await new Promise<Record<string,unknown>>((resolve,reject)=>{
      deadline=setTimeout(()=>reject(Error('Cooperative worker did not finish')),10000)
      worker.onerror=event=>reject(Error(event.message))
      worker.onmessage=event=>{
        if(event.data.type==='started')cancelTimer=setTimeout(()=>{
          cancelSentAt=performance.now();worker.postMessage('cancel')
        },100)
        else if(event.data.type==='error')reject(Error(event.data.error))
        else if(event.data.type==='result'){
          if(!cancelSentAt)return reject(Error('Worker finished before cancellation was sent'))
          resolve({...event.data.result,messageToRecoveryMs:performance.now()-cancelSentAt})
        }
      }
      worker.postMessage({type:'start',wasm})
    })
  }finally{clearTimeout(cancelTimer);clearTimeout(deadline);worker.terminate()}
}
