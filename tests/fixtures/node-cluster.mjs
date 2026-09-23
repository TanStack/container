import cluster from 'node:cluster'
if(cluster.isWorker){process.send({kind:'ready',worker:cluster.worker.id,pid:process.pid});process.on('disconnect',()=>process.exit(0))}
else {
  const events=[]
  cluster.setupPrimary({exec:new URL(import.meta.url).pathname,serialization:'advanced',silent:true})
  const worker=cluster.fork({FIXTURE:'cluster'})
  worker.on('online',()=>events.push('online'))
  worker.on('message',message=>{events.push('message:'+message.kind);worker.disconnect()})
  worker.on('disconnect',()=>events.push('disconnect'))
  worker.on('exit',(code,signal)=>{events.push('exit:'+code+':'+signal);console.log(JSON.stringify({events,id:worker.id,isDead:worker.isDead(),primary:cluster.isPrimary,master:cluster.isMaster,constants:[cluster.SCHED_NONE,cluster.SCHED_RR]}))})
}
