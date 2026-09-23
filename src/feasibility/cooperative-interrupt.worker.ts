import {probeCooperativeInterrupt} from './cooperative-interrupt'

const controller=new AbortController()
let started=false
self.onmessage=event=>{
  if(event.data==='cancel')controller.abort()
  else if(event.data?.type==='start'&&!started){
    started=true
    void probeCooperativeInterrupt({signal:controller.signal,started:()=>self.postMessage({type:'started'})},event.data.wasm===true)
      .then(result=>self.postMessage({type:'result',result}),error=>self.postMessage({type:'error',error:String(error)}))
  }
}
