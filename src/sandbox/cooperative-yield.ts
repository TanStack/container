// One pending resume per engine. A posted message yields to the host task queue
// without the minimum delay imposed on repeatedly nested timers.
export class CooperativeYield {
  #channel:MessageChannel|undefined
  #pending:(()=>void)|undefined
  #closed=false
  schedule(resume:()=>void){
    if(this.#closed)throw Error('Cooperative yield closed')
    if(this.#pending)throw Error('Cooperative resume already pending')
    if(!this.#channel){
      this.#channel=new MessageChannel()
      this.#channel.port1.onmessage=()=>{
        const pending=this.#pending
        this.#pending=undefined
        pending?.()
      }
    }
    this.#pending=resume
    try{this.#channel.port2.postMessage(null)}catch(error){this.#pending=undefined;throw error}
  }
  close(){
    if(this.#pending)throw Error('Cannot close a suspended cooperative yield')
    this.#closed=true
    if(this.#channel){
      this.#channel.port1.onmessage=null
      this.#channel.port1.close();this.#channel.port2.close()
      this.#channel=undefined
    }
  }
}
