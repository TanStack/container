;(() => {
  globalThis.document?.currentScript?.remove()
  const documentChannel = new MessageChannel()
  parent.postMessage({type:'sandbox-websocket-document'}, '*', [documentChannel.port2])
  const sockets = new Set()
  const encoder = new TextEncoder()
  class WorkspaceWebSocket extends EventTarget {
    static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3
    #state=0; #url; #protocol=''; #binaryType='blob'; #buffered=0
    #port; #writes=Promise.resolve()
    onopen=null; onmessage=null; onerror=null; onclose=null
    constructor(address, protocols=[]) {
      super()
      const url=new URL(String(address),location.href)
      if(url.protocol==='http:')url.protocol='ws:'
      if(url.protocol==='https:')url.protocol='wss:'
      if(!['ws:','wss:'].includes(url.protocol)||url.hash||url.username||url.password)throw new DOMException('Invalid WebSocket URL','SyntaxError')
      const previewAddress=url.host===location.host&&url.protocol===(location.protocol==='https:'?'wss:':'ws:')
      const guestLoopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.protocol==='ws:'
      // Dev servers advertise their guest-side loopback address. It remains a
      // virtual address because the parent selects the one kernel and guest
      // port, but retaining it gives the guest the Host header it advertised.
      if(!previewAddress&&!guestLoopback)throw new DOMException('WebSocket outside workspace','SecurityError')
      protocols=typeof protocols==='string'?[protocols]:Array.from(protocols,String)
      if(new Set(protocols).size!==protocols.length||protocols.some(value=>!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)))throw new DOMException('Invalid WebSocket protocols','SyntaxError')
      this.#url=url.href
      const channel=new MessageChannel();this.#port=channel.port1
      sockets.add(this)
      channel.port1.onmessage=event=>{
        if(this.#state===3)return
        const message=event.data
        if(message.type==='open'){
          if(this.#state===2){this.#port.postMessage({type:'pull'});return}
          this.#state=1;this.#protocol=message.protocol
          this.#emit(new Event('open'));this.#port.postMessage({type:'pull'})
        }else if(message.type==='message'){
          if(this.#state===1){
            const data=typeof message.data==='string'?message.data:this.#binaryType==='arraybuffer'?message.data:new Blob([message.data])
            this.#emit(new MessageEvent('message',{data,origin:location.origin}))
          }
          if(this.#state!==3)this.#port.postMessage({type:'pull'})
        }else if(message.type==='sent')this.#buffered=Math.max(0,this.#buffered-message.bytes)
        else if(message.type==='close')this.#finish(message.code,message.reason,message.clean)
        else if(message.type==='error'){
          if(message.message)console.error('[sandbox websocket] '+message.message)
          this.#emit(new Event('error'));this.#finish(1006,'',false)
        }
      }
      documentChannel.port1.postMessage({type:'connect',url:url.href,protocols},[channel.port2])
    }
    get url(){return this.#url} get readyState(){return this.#state}
    get protocol(){return this.#protocol} get extensions(){return ''}
    get bufferedAmount(){return this.#buffered} get binaryType(){return this.#binaryType}
    set binaryType(value){if(value==='blob'||value==='arraybuffer')this.#binaryType=value}
    #emit(event){this.dispatchEvent(event);const handler=this['on'+event.type];if(typeof handler==='function'){try{handler.call(this,event)}catch(error){setTimeout(()=>{throw error})}}}
    #finish(code,reason,clean){
      if(this.#state===3)return
      this.#state=3;this.#port.close();sockets.delete(this)
      this.#emit(new CloseEvent('close',{code,reason,wasClean:Boolean(clean)}))
    }
    send(value){
      if(this.#state===0)throw new DOMException('WebSocket is connecting','InvalidStateError')
      let data,size
      if(value instanceof Blob){data=value;size=value.size}
      else if(value instanceof ArrayBuffer||ArrayBuffer.isView(value)){
        const bytes=value instanceof ArrayBuffer?new Uint8Array(value):new Uint8Array(value.buffer,value.byteOffset,value.byteLength)
        data=bytes.slice().buffer;size=bytes.byteLength
      }else{data=String(value);size=encoder.encode(data).byteLength}
      if(this.#state!==1){this.#buffered+=size;return}
      if(size>1024*1024||this.#buffered+size>2*1024*1024){this.#port.postMessage({type:'dispose'});this.#emit(new Event('error'));this.#finish(1009,'Message limit exceeded',false);return}
      this.#buffered+=size
      this.#writes=this.#writes.then(async()=>{
        if(data instanceof Blob)data=await data.arrayBuffer()
        if(this.#state===3)return
        this.#port.postMessage({type:'send',data},typeof data==='string'?[]:[data])
      }).catch(()=>{if(this.#state===3)return;this.#port.postMessage({type:'dispose'});this.#emit(new Event('error'));this.#finish(1006,'',false)})
    }
    close(code=1000,reason=''){
      if(code!==1000&&!(Number.isInteger(code)&&code>=3000&&code<=4999))throw new DOMException('Invalid close code','InvalidAccessError')
      reason=String(reason)
      if(encoder.encode(reason).byteLength>123)throw new DOMException('Close reason too long','SyntaxError')
      if(this.#state>=2)return
      this.#state=2
      this.#writes=this.#writes.then(()=>{if(this.#state!==3)this.#port.postMessage({type:'close',code,reason})})
    }
    _dispose(){
      if(this.#state===3)return
      this.#state=3
      this.#port.postMessage({type:'detach'})
      this.#port.onmessage=null
      this.#port.close();sockets.delete(this)
      // The document is leaving, not observing a remote socket failure.
      // Running app close handlers here can start reconnect work during unload.
    }
  }
  for(const [name,value] of Object.entries({CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3}))Object.defineProperty(WorkspaceWebSocket.prototype,name,{value})
  Object.defineProperty(WorkspaceWebSocket.prototype,Symbol.toStringTag,{value:'WebSocket'})
  Object.defineProperty(globalThis,'WebSocket',{value:WorkspaceWebSocket,writable:true,configurable:true})
  addEventListener('pagehide',()=>{for(const socket of sockets)socket._dispose();documentChannel.port1.close()})
})()
