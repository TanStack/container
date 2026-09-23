export type ProcessLifetime='bounded'|'session'

// A session may wait indefinitely for I/O. Its synchronous work and uninterrupted
// microtask chains still have a deadline. Only the trusted event loop can end a
// turn, and only after its runnable promise jobs have drained.
export class ExecutionBudget {
  #deadline:number|undefined
  constructor(readonly timeoutMs:number,readonly lifetime:ProcessLifetime='bounded',readonly now=()=>performance.now()){
    this.#deadline=now()+timeoutMs
  }
  beginTurn(){this.#deadline??=this.now()+this.timeoutMs}
  endTurn(ready:boolean){if(this.lifetime==='session'&&!ready&&!this.expired)this.#deadline=undefined}
  get expired(){this.beginTurn();return this.now()>this.#deadline!}
  get waitTimeout(){return this.#deadline===undefined?undefined:Math.max(1,this.#deadline-this.now())}
  snapshot(){return {lifetime:this.lifetime,timeoutMs:this.timeoutMs,deadline:this.#deadline??null,remainingMs:this.#deadline===undefined?null:this.#deadline-this.now()}}
}

export function processLifetime(value:unknown,inherited?:ProcessLifetime):ProcessLifetime{
  if(value!==undefined&&value!=='bounded'&&value!=='session')throw Error('Invalid process lifetime')
  if(inherited==='bounded'&&value==='session')throw Error('A bounded process cannot create a session process')
  return value??inherited??'bounded'
}
