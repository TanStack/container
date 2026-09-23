/** Optional diagnostic ABI, absent from engines built without guest sampling. */
export interface GuestSamplingModule {
  HEAPU8?: Uint8Array
  _QJS_GuestSamplingReset?(runtime:number,enabled:number):number
  _QJS_GuestSamplingCount?(runtime:number):number
  _QJS_GuestSamplingRead?(runtime:number,index:number,field:number):number
  _QJS_GuestSamplingText?(runtime:number,index:number,kind:number):number
}
export interface GuestSample {
  time:number
  offset:number
  bytecodeLength:number
  flags:number
  functionName:string
  filename:string
  sequence:number
}
export interface GuestSamplingSnapshot {samples:GuestSample[];dropped:number;error?:string}
export interface GuestSamplingReader {snapshot():GuestSamplingSnapshot;close():void}

const owners=new WeakMap<object,Set<number>>()
const decoder=new TextDecoder('utf-8',{fatal:true})
function integer(value:number,min:number,max:number,label:string){
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`Invalid guest sampling ${label}`)
  return value
}
function message(error:unknown){return error instanceof Error?error.message:String(error)}

/** Call before guest execution, and close before disposing the runtime. */
export function createGuestSamplingReader(module:GuestSamplingModule,runtime:number):GuestSamplingReader|undefined {
  const reset=module._QJS_GuestSamplingReset,count=module._QJS_GuestSamplingCount
  const read=module._QJS_GuestSamplingRead,text=module._QJS_GuestSamplingText
  if(!reset||!count||!read||!text)return undefined
  let closed=false,lastSequence=0,error:string|undefined,owned=false
  let runtimes=owners.get(module)
  if(!runtimes){runtimes=new Set();owners.set(module,runtimes)}
  try{
    integer(runtime,1,0xffffffff,'runtime pointer')
    if(runtimes.has(runtime))throw new Error('Guest sampling already has a reader for this runtime')
    runtimes.add(runtime);owned=true
    const result=reset.call(module,runtime,1)
    if(result===-1)throw new Error('Guest sampling buffer allocation failed')
    if(result!==1)throw new Error('Invalid guest sampling reset result')
  }catch(cause){error=message(cause)}

  function copyText(index:number,kind:number,length:number){
    const pointer=text!.call(module,runtime,index,kind)
    // Fetch the current heap after every ABI call, which may grow WASM memory.
    const heap=module.HEAPU8
    if(!(heap instanceof Uint8Array))throw new Error('Invalid guest sampling heap')
    integer(pointer,1,heap.length,'text pointer')
    if(length>heap.length-pointer)throw new Error('Invalid guest sampling text bounds')
    return decoder.decode(heap.slice(pointer,pointer+length))
  }
  return {
    snapshot(){
      if(error)return {samples:[],dropped:0,error}
      if(closed)return {samples:[],dropped:0,error:'Guest sampling reader is closed'}
      try{
        const size=integer(count.call(module,runtime),0,512,'count')
        const samples:GuestSample[]=[]
        let previous=0,dropped=0
        for(let index=0;index<size;index++){
          const field=(key:number)=>read!.call(module,runtime,index,key)
          const sequence=integer(field(6),1,Number.MAX_SAFE_INTEGER,'sequence')
          if(index&&sequence!==previous+1)throw new Error('Invalid guest sampling sequence order')
          previous=sequence
          if(sequence<=lastSequence)continue
          const time=field(0)
          if(!Number.isFinite(time)||time<0)throw new Error('Invalid guest sampling time')
          const offset=integer(field(1),-1,0xffffffff,'offset')
          const bytecodeLength=integer(field(2),0,0xffffffff,'bytecode length')
          const flags=integer(field(3),0,0xffffffff,'flags')
          if(flags&8?offset!==-1:offset<0||offset>=bytecodeLength)throw new Error('Invalid guest sampling offset bounds')
          const functionLength=integer(field(4),0,95,'function length')
          const filenameLength=integer(field(5),0,191,'filename length')
          const functionName=copyText(index,0,functionLength),filename=copyText(index,1,filenameLength)
          if(sequence>lastSequence){
            if(samples.length===0)dropped=Math.max(0,sequence-lastSequence-1)
            samples.push({time,offset,bytecodeLength,flags,functionName,filename,sequence})
          }
        }
        if(previous<lastSequence)throw new Error('Guest sampling sequence moved backwards')
        if(samples.length)lastSequence=samples[samples.length-1].sequence
        return {samples,dropped}
      }catch(cause){return {samples:[],dropped:0,error:message(cause)}}
    },
    close(){
      if(closed)return
      closed=true
      if(!owned)return
      try{reset.call(module,runtime,0)}catch(cause){error=message(cause)}
      finally{runtimes!.delete(runtime)}
    },
  }
}

/** Only invoke at a completed guest boundary, never from a scheduler callback. */
export function createGuestSamplingPublisher(reader:GuestSamplingReader,publish:(snapshot:GuestSamplingSnapshot)=>void,clock:()=>number=()=>performance.now()){
  let lastAt=-Infinity,lastError:string|undefined
  return (force=false)=>{
    try{
      const at=clock()
      if(!force&&at-lastAt<1000)return
      lastAt=at
      const snapshot=reader.snapshot()
      if(snapshot.samples.length||snapshot.dropped||snapshot.error&&snapshot.error!==lastError)publish(snapshot)
      lastError=snapshot.error
    }catch{/* Diagnostics cannot replace a guest result or error. */}
  }
}

export function createGuestSamplingBoundaries(reader:GuestSamplingReader,publish:(snapshot:GuestSamplingSnapshot)=>void,clock?:()=>number){
  const emit=createGuestSamplingPublisher(reader,publish,clock)
  let safe=true
  return {
    begin(){safe=false},
    observeStep(status:number|undefined){safe=status===2},
    completed(){if(safe)emit()},
    flush(){if(safe)emit(true)},
  }
}
