const failure=(code:string,message:string)=>Object.assign(Error(message),{code})
export interface MessageResource {dispose():void}
type Message={bytes:Uint8Array;resources:readonly MessageResource[]}

// One direction of an IPC channel. Payload encoding belongs to the guest
// serializer. Optional host resources stay owned until acknowledged or dropped.
export class ProcessMessageQueue {
  #messages:Message[]=[]
  #bytes=0
  #ended=false
  #reader?:{lease:false;resolve:(bytes:Uint8Array|null)=>void;reject:(error:Error)=>void}|{lease:true;resolve:(value:{token:number;bytes:Uint8Array}|null)=>void;reject:(error:Error)=>void}
  #inFlight?:Message&{token:number}
  #nextToken=0
  constructor(readonly maxBytes=4*1024*1024,readonly maxMessages=256,readonly maxMessageBytes=maxBytes){
    for(const value of [maxBytes,maxMessages,maxMessageBytes])if(!Number.isSafeInteger(value)||value<=0)throw new RangeError('IPC limits must be positive integers')
  }
  get queuedBytes(){return this.#bytes}
  get connected(){return !this.#ended}
  // Tokens are assigned in FIFO delivery order. Snapshot only messages already
  // admitted, including a leased message whose VM promise is not settled yet.
  pollSnapshot(){return {token:this.#nextToken+this.#messages.length,closed:this.#ended&&!this.#inFlight&&!this.#messages.length}}
  #unowned(message:Message|undefined){if(message?.resources.length)throw failure('ERR_INVALID_STATE','Resource-bearing IPC messages require acknowledged delivery')}
  #release(messages:Message[]){
    let error:unknown
    for(const message of messages)for(const resource of message.resources)try{resource.dispose()}catch(cause){error??=cause}
    if(error!==undefined)throw error
  }
  take(){
    if(this.#inFlight)throw failure('EBUSY','An acknowledged receive is pending')
    this.#unowned(this.#messages[0])
    const message=this.#messages.shift();if(message)this.#bytes-=message.bytes.byteLength;return message?.bytes
  }
  takeLease(){
    if(this.#reader)throw failure('EBUSY','An IPC receive is already pending')
    if(this.#inFlight){this.#unowned(this.#inFlight);const value=this.#inFlight;this.#inFlight=undefined;this.#bytes-=value.bytes.byteLength;return value.bytes}
    this.#unowned(this.#messages[0])
    const message=this.#messages.shift();if(message)this.#bytes-=message.bytes.byteLength;return message?.bytes
  }
  /** Synchronous acknowledged delivery, retaining resources until ack or drop. */
  takeDelivery():{token:number;bytes:Uint8Array}|undefined{
    if(this.#reader)throw failure('EBUSY','An IPC receive is already pending')
    if(this.#inFlight)return {token:this.#inFlight.token,bytes:this.#inFlight.bytes}
    if(!this.#messages.length)return undefined
    if(this.#nextToken>=Number.MAX_SAFE_INTEGER)throw failure('ERR_RESOURCE_LIMIT','IPC delivery tokens exhausted')
    const message=this.#messages.shift()!
    this.#inFlight={...message,token:++this.#nextToken}
    return {token:this.#inFlight.token,bytes:message.bytes}
  }
  cancelReceive(){this.#reader?.resolve(null);this.#reader=undefined}
  /** Ownership transfers only on success, including a false backpressure result.
   * On throw, the caller still owns every supplied resource. */
  send(bytes:Uint8Array,resources:readonly MessageResource[]=[]){
    if(this.#ended)throw failure('ERR_IPC_CHANNEL_CLOSED','IPC channel is closed')
    if(!(bytes instanceof Uint8Array))throw new TypeError('IPC payload must be bytes')
    if(bytes.byteLength>this.maxMessageBytes||bytes.byteLength>this.maxBytes)throw failure('ERR_RESOURCE_LIMIT','IPC message exceeds the byte limit')
    if(!Array.isArray(resources)||resources.length>256||new Set(resources).size!==resources.length||resources.some(resource=>!resource||typeof resource.dispose!=='function'))throw new TypeError('Invalid IPC resources')
    if(this.#reader){
      const reader=this.#reader
      if(resources.length&&!reader.lease)throw failure('ERR_INVALID_STATE','Resource-bearing IPC messages require acknowledged delivery')
      if(reader.lease){
        if(this.#nextToken>=Number.MAX_SAFE_INTEGER)throw failure('ERR_RESOURCE_LIMIT','IPC delivery tokens exhausted')
        const value={token:++this.#nextToken,bytes:bytes.slice(),resources:[...resources]};this.#inFlight=value;this.#bytes+=value.bytes.byteLength;this.#reader=undefined;reader.resolve({token:value.token,bytes:value.bytes})
      }else {const copy=bytes.slice();this.#reader=undefined;reader.resolve(copy)}
      return true
    }
    if(this.#messages.length+(this.#inFlight?1:0)>=this.maxMessages||this.#bytes+bytes.byteLength>this.maxBytes)throw failure('ERR_RESOURCE_LIMIT','IPC queue is full')
    this.#messages.push({bytes:bytes.slice(),resources:[...resources]});this.#bytes+=bytes.byteLength
    return this.#bytes<this.maxBytes/2&&this.#messages.length<this.maxMessages/2
  }
  receive():Promise<Uint8Array|null>{
    if(this.#reader||this.#inFlight)throw failure('EBUSY','An IPC receive is already pending')
    this.#unowned(this.#messages[0])
    const message=this.#messages.shift()
    if(message){this.#bytes-=message.bytes.byteLength;return Promise.resolve(message.bytes)}
    if(this.#ended)return Promise.resolve(null)
    return new Promise((resolve,reject)=>{this.#reader={lease:false,resolve,reject}})
  }
  ackReceive(token:number){
    if(!this.#inFlight||this.#inFlight.token!==token)throw failure('ERR_INVALID_STATE','Invalid IPC delivery acknowledgement')
    const message=this.#inFlight
    this.#bytes-=message.bytes.byteLength;this.#inFlight=undefined
    this.#release([message])
  }
  dropReceive(token:number){this.ackReceive(token)}
  deliveryResources(token:number){
    if(!this.#inFlight||this.#inFlight.token!==token)throw failure('ERR_INVALID_STATE','Invalid IPC delivery')
    return this.#inFlight.resources
  }
  receiveLease():Promise<{token:number;bytes:Uint8Array}|null>{
    if(this.#reader)throw failure('EBUSY','An IPC receive is already pending')
    const delivery=this.takeDelivery()
    if(delivery)return Promise.resolve(delivery)
    if(this.#ended)return Promise.resolve(null)
    return new Promise((resolve,reject)=>{this.#reader={lease:true,resolve,reject}})
  }
  // Graceful disconnect preserves already accepted messages before EOF.
  end(){this.#ended=true;this.#reader?.resolve(null);this.#reader=undefined}
  // Process termination discards queued data and releases a waiting receiver.
  close(error?:Error){
    const messages=this.#inFlight?[...this.#messages,this.#inFlight]:this.#messages
    this.#ended=true;this.#messages=[];this.#inFlight=undefined;this.#bytes=0
    if(error)this.#reader?.reject(error);else this.#reader?.resolve(null)
    this.#reader=undefined
    this.#release(messages)
  }
}
