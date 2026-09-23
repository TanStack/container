export type MailboxTask = Readonly<{taskId:number;generation:number}>
export type MailboxRequest = Readonly<MailboxTask & {requestId:number}>
export type MailboxResult<Value,ErrorData> = {ok:true;value:Value}|{ok:false;error:ErrorData}
export type MailboxCompletion<Value,ErrorData> =
  | {kind:'result';request:MailboxRequest;result:MailboxResult<Value,ErrorData>}
  | {kind:'cancelled';error:ErrorData}

type Task<Value,ErrorData> = {
  identity:MailboxTask
  request?:MailboxRequest
  result?:MailboxResult<Value,ErrorData>
  consumed:boolean
  cancelled:boolean
  cancellation?:MailboxCompletion<Value,ErrorData>
}

/** Experimental scheduler building block, not a scheduler or guest execution API.
 * Values must be owned plain data, never guest handles or callbacks. Delivery and
 * cancellation only record data. The scheduler resumes and unwinds guest calls.
 */
export class ThreadGroupMailbox<Value,ErrorData> {
  #tasks=new Map<number,Task<Value,ErrorData>>()
  #generation=0
  #requestId=0
  #pending=0
  constructor(readonly maxPending=512){
    if(!Number.isSafeInteger(maxPending)||maxPending<1)throw new RangeError('Invalid mailbox quota')
  }
  get pending(){return this.#pending}
  createTask(taskId:number):MailboxTask{
    if(!Number.isSafeInteger(taskId)||taskId<0)throw new RangeError('Invalid task ID')
    if(this.#tasks.has(taskId))throw new Error('Task already exists')
    if(this.#generation===Number.MAX_SAFE_INTEGER)throw new RangeError('Task generations exhausted')
    const identity=Object.freeze({taskId,generation:++this.#generation})
    this.#tasks.set(taskId,{identity,consumed:false,cancelled:false})
    return identity
  }
  #find(identity:MailboxTask){
    const task=this.#tasks.get(identity.taskId)
    return task?.identity.generation===identity.generation?task:undefined
  }
  #get(identity:MailboxTask){
    const task=this.#find(identity)
    if(!task)throw new Error('Unknown task generation')
    return task
  }
  /** Register only after the scheduler owns the parked continuation. */
  park(identity:MailboxTask):MailboxRequest{
    const task=this.#get(identity)
    if(task.cancelled)throw new Error('Task cancelled')
    if(task.request)throw new Error('Task requires unwind acknowledgment')
    if(this.#pending>=this.maxPending)throw new Error('Mailbox pending quota exceeded')
    if(this.#requestId===Number.MAX_SAFE_INTEGER)throw new RangeError('Request IDs exhausted')
    const request=Object.freeze({...task.identity,requestId:++this.#requestId})
    task.request=request;task.consumed=false;this.#pending++
    return request
  }
  deliver(request:MailboxRequest,result:MailboxResult<Value,ErrorData>):boolean{
    const task=this.#find(request)
    if(!task||task.cancelled||task.request?.requestId!==request.requestId||task.result!==undefined||task.consumed)return false
    task.result=result
    return true
  }
  /** Cancellation wins over a delivered result that has not been consumed. */
  cancel(identity:MailboxTask,error:ErrorData):boolean{
    const task=this.#find(identity)
    if(!task||task.cancelled)return false
    task.cancelled=true;task.result=undefined
    task.cancellation={kind:'cancelled',error}
    return true
  }
  /** Called at a scheduler boundary. Returns each result or cancellation once. */
  consume(identity:MailboxTask):MailboxCompletion<Value,ErrorData>|undefined{
    const task=this.#get(identity)
    if(task.cancellation){
      const cancellation=task.cancellation;task.cancellation=undefined
      task.consumed=true
      return cancellation
    }
    if(task.consumed||!task.request||task.result===undefined)return undefined
    const completion:MailboxCompletion<Value,ErrorData>={kind:'result',request:task.request,result:task.result}
    task.result=undefined;task.consumed=true
    return completion
  }
  /** Call only after the owning continuation has resumed and unwound its park. */
  acknowledgeUnwind(request:MailboxRequest):void{
    const task=this.#get(request)
    if(task.request?.requestId!==request.requestId)throw new Error('Unknown parked request')
    if(!task.consumed||task.cancellation)throw new Error('Completion has not been consumed')
    task.request=undefined;task.result=undefined;this.#pending--
  }
  disposeTask(identity:MailboxTask):void{
    const task=this.#get(identity)
    if(task.request)throw new Error('Task requires unwind acknowledgment')
    if(task.cancellation)throw new Error('Cancellation has not been consumed')
    this.#tasks.delete(identity.taskId)
  }
}
