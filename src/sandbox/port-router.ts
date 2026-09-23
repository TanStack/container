import {ProcessMessageQueue,type MessageResource} from './process-message-queue'
const fail=(message:string)=>Object.assign(Error(message),{code:'ERR_INVALID_STATE'})
interface Endpoint {owner:number;peer:number;queue:ProcessMessageQueue;closed:boolean}
export class PortRouter {
 #next=1
 #ports=new Map<number,Endpoint>()
 pair(owner:number){
  if(this.#ports.size>=512)throw fail('MessagePort limit exceeded')
  const a=this.#next++,b=this.#next++
  this.#ports.set(a,{owner,peer:b,queue:new ProcessMessageQueue(),closed:false})
  this.#ports.set(b,{owner,peer:a,queue:new ProcessMessageQueue(),closed:false})
  return [a,b]
 }
 #get(owner:number,id:number){const endpoint=this.#ports.get(id);if(!endpoint||endpoint.owner!==owner||endpoint.closed)throw fail('MessagePort is closed or belongs to another process');return endpoint}
 validate(owner:number,ids:number[]){
  if(!Array.isArray(ids)||ids.length>256||new Set(ids).size!==ids.length)throw fail('Invalid MessagePort transfer list')
  for(const id of ids)this.#get(owner,id)
 }
 move(owner:number,target:number,ids:number[]){
  this.validate(owner,ids)
  for(const id of ids){const endpoint=this.#get(owner,id);endpoint.queue.cancelReceive();endpoint.owner=target}
 }
 send(owner:number,id:number,bytes:Uint8Array,ids:number[]=[],resources:readonly MessageResource[]=[]){
  const endpoint=this.#get(owner,id),peer=this.#ports.get(endpoint.peer)
  this.validate(owner,ids)
  if(ids.includes(id)||ids.includes(endpoint.peer))throw fail('Cannot transfer the sending or receiving MessagePort')
  if(!peer||peer.closed)throw fail('MessagePort peer is closed')
  peer.queue.send(bytes,resources)
  this.move(owner,peer.owner,ids)
  return peer.owner
 }
 receive(owner:number,id:number){return this.#get(owner,id).queue.receiveLease()}
 ack(owner:number,id:number,token:number){this.#get(owner,id).queue.ackReceive(token)}
 resources(owner:number,id:number,token:number){return this.#get(owner,id).queue.deliveryResources(token)}
 take(owner:number,id:number){return this.#get(owner,id).queue.takeLease()??null}
 takeDelivery(owner:number,id:number){return this.#get(owner,id).queue.takeDelivery()??null}
 close(owner:number,id:number){
  const endpoint=this.#get(owner,id);endpoint.closed=true;endpoint.queue.close()
  const peer=this.#ports.get(endpoint.peer);peer?.queue.end()
  if(!peer||peer.closed){this.#ports.delete(id);this.#ports.delete(endpoint.peer)}
 }
 release(owner:number){for(const [id,endpoint] of [...this.#ports])if(endpoint.owner===owner&&!endpoint.closed)this.close(owner,id)}
}
