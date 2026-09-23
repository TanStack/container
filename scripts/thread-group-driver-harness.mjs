import {ThreadGroupMailbox} from '../src/sandbox/thread-group-mailbox.ts'
import {TaskScheduler} from '../src/sandbox/task-scheduler.ts'

export async function runDriver(engine,readValue){
  const api={create:engine.cwrap('group_create','number',['string']),step:engine.cwrap('group_step',null,['number']),status:engine.cwrap('group_status','number',['number']),request:engine.cwrap('group_request','number',['number']),deliver:engine.cwrap('group_deliver','number',['number','number','number']),cancel:engine.cwrap('group_cancel',null,['number']),close:engine.cwrap('group_close','number',['number']),shutdown:engine.cwrap('group_shutdown','number',[])}
  const check=(condition,label)=>{if(!condition)throw Error(label)}
  const step=task=>{api.step(task);return api.status(task)}
  const mailbox=new ThreadGroupMailbox(4),scheduler=new TaskScheduler()
  try{
    const a=api.create("const view=new Uint8Array(bytes);view[0]=7;if(hostRead()!==42||view[0]!==21)throw Error('missing host result or peer progress');")
    const b=api.create("const view=new Uint8Array(bytes);if(view[0]!==7)throw Error('missing parent progress');view[0]=21;")
    const identity=mailbox.createTask(1)
    check(step(a)===1,'Parent must park and return to JS')
    const request=mailbox.park(identity),nativeRequest=api.request(a)
    check(step(b)===2,'Peer must finish while parent parked')
    check(api.close(b)===1,'Peer cleanup')
    const waiting=scheduler.wait(false,2000)
    const arrival=readValue().then(value=>{
      check(mailbox.deliver(request,{ok:true,value})===true,'Mailbox accepts host result')
      scheduler.wake()
    })
    await waiting;await arrival
    const completion=mailbox.consume(identity)
    check(completion?.kind==='result'&&completion.result.ok,'Host read result available')
    check(api.deliver(a,nativeRequest,completion.result.value)===1,'Deliver at scheduler boundary')
    check(step(a)===2,'Parent resumes from separate JS call')
    mailbox.acknowledgeUnwind(request);mailbox.disposeTask(identity)
    check(api.close(a)===1&&api.shutdown()===1,'Normal group cleanup')

    const cancelled=api.create("hostRead();throw Error('Cancelled task continued');")
    const nextIdentity=mailbox.createTask(1)
    check(step(cancelled)===1,'Cancellation case parks')
    const nextRequest=mailbox.park(nextIdentity)
    check(!mailbox.deliver(request,{ok:true,value:99}),'Old task generation rejected')
    const late=new Promise(resolve=>setTimeout(()=>resolve(mailbox.deliver(nextRequest,{ok:true,value:42})),10))
    check(mailbox.cancel(nextIdentity,{message:'cancelled'}),'Record cancellation')
    check(mailbox.consume(nextIdentity)?.kind==='cancelled','Consume cancellation')
    api.cancel(cancelled)
    check(step(cancelled)===3,'Cancelled stack unwinds')
    mailbox.acknowledgeUnwind(nextRequest);mailbox.disposeTask(nextIdentity)
    check(api.close(cancelled)===1&&api.shutdown()===1,'Cancelled group cleanup')
    check(await late===false,'Late completion ignores disposed task')
    check(mailbox.pending===0,'No parked requests remain')
    return {externalDriver:true,hostRead:true,peerProgress:true,cancellation:true,lateCompletion:true,generationCheck:true,pending:0}
  }finally{scheduler.close()}
}
