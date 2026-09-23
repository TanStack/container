export type WorkerMessageSample={kind:'send'|'receive';endpoint:number;token?:number;sentAt?:number;receivedAt?:number;settledAt?:number;waitMs?:number;protocol?:string;tid?:number}
type Sample=WorkerMessageSample

// Read only scalar protocol labels from the advanced IPC graph. Do not decode
// resource nodes, retain message bodies, or affect whether delivery succeeds.
function protocolLabel(bytes:Uint8Array):{protocol?:string;tid?:number}{
  try{
    if(bytes.byteLength>65536)return {}
    const graph=JSON.parse(new TextDecoder().decode(bytes))
    const field=(token:unknown,key:string):unknown=>{
      if(!Array.isArray(token)||token[0]!=='ref'||!Number.isInteger(token[1]))return
      const node=graph.nodes?.[token[1]]
      if(!Array.isArray(node)||node[0]!=='object'||!Array.isArray(node[1]))return
      return node[1].find((entry:unknown)=>Array.isArray(entry)&&entry[0]===key)?.[1]
    }
    const scalar=(token:unknown)=>Array.isArray(token)&&token[0]==='value'?token[1]:undefined
    const protocol=field(graph.root,'__emnapi__'),name=scalar(field(protocol,'type'))
    const tid=scalar(field(field(protocol,'payload'),'tid'))
    return {...(typeof name==='string'&&['load','loaded','start','cleanup-thread','spawn-thread','terminate-all-threads'].includes(name)?{protocol:name}:{}),...(Number.isSafeInteger(tid)?{tid}: {})}
  }catch{return {}}
}

export class WorkerMessageTiming {
  readonly samples:Sample[]=[]
  constructor(private readonly clock:()=>number,private readonly limit=96,private readonly observe?:(sample:Sample)=>void,private readonly lifecycleOnly=false){}
  send(endpoint:number,bytes:Uint8Array):void{
    if(this.samples.length>=this.limit)return
    const label=protocolLabel(bytes)
    if(this.lifecycleOnly&&!label.protocol)return
    const sample:Sample={kind:'send',endpoint,sentAt:this.clock(),...label}
    this.samples.push(sample);this.observe?.({...sample})
  }
  receive(endpoint:number,delivery:{token:number;bytes:Uint8Array}):(()=>void)|undefined{
    if(this.samples.length>=this.limit)return
    const label=protocolLabel(delivery.bytes)
    if(this.lifecycleOnly&&!label.protocol)return
    const receivedAt=this.clock()
    const sample:Sample={kind:'receive',endpoint,token:delivery.token,receivedAt,...label}
    this.samples.push(sample)
    this.observe?.({...sample})
    return ()=>{
      if(sample.settledAt!==undefined)return
      sample.settledAt=this.clock();sample.waitMs=sample.settledAt-receivedAt
      this.observe?.({...sample})
    }
  }
}
