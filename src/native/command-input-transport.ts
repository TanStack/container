type InputMessage={type:'native-thread-input';bytes:Uint8Array|null;inputId:number}
type Pending={message:InputMessage;resolve:()=>void;reject:(error:Error)=>void}

/** A bounded parent queue with one chunk in flight until the Readable asks for more. */
export class NativeCommandInputTransport {
  #queue:Pending[]=[]
  #bytes=0
  #next=0
  #ready=false
  #closed=false
  #ended=false
  constructor(private send:(message:InputMessage)=>void){}
  write(bytes:Uint8Array|null):Promise<void>{
    if(this.#closed||this.#ended)throw Object.assign(Error('Command input is closed'),{code:'EPIPE'})
    if(bytes!==null&&(!(bytes instanceof Uint8Array)||bytes.byteLength>65536))throw Error('Invalid command input chunk')
    if(this.#queue.length>=1024||this.#bytes+(bytes?.byteLength??0)>1024*1024)throw Error('Command input queue is full')
    this.#ended=bytes===null
    const message:InputMessage={type:'native-thread-input',bytes:bytes?.slice()??null,inputId:++this.#next}
    const receipt=new Promise<void>((resolve,reject)=>this.#queue.push({message,resolve,reject}))
    this.#bytes+=bytes?.byteLength??0
    if(this.#ready&&this.#queue.length===1)this.#send()
    return receipt
  }
  start(){if(this.#ready||this.#closed)return;this.#ready=true;this.#send()}
  #send(){
    const pending=this.#queue[0]
    if(!pending)return
    try{this.send(pending.message)}catch(error){this.close(error instanceof Error?error:Error(String(error)))}
  }
  acknowledge(inputId:number){
    const pending=this.#queue[0]
    if(!pending||pending.message.inputId!==inputId)return
    this.#queue.shift();this.#bytes-=pending.message.bytes?.byteLength??0
    pending.resolve()
    this.#send()
  }
  close(error=Object.assign(Error('Command input is closed'),{code:'EPIPE'})){
    if(this.#closed)return
    this.#closed=true
    for(const pending of this.#queue.splice(0))pending.reject(error)
    this.#bytes=0
  }
}
