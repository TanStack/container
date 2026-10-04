// Passive, bounded browser-test evidence. No response is read, split or delayed.
export function installNativeStreamObservation({previewOrigin}){
  if(location.origin!==previewOrigin)return
  const rows=[]
  let run=0,started=0,last=''
  const record=kind=>{
    const results=document.querySelector('#streamed-results')
    if(!results||!run||rows.length>=256)return
    const streams=[...results.querySelectorAll('pre')].map(element=>{
      const text=element.textContent??''
      return {first:(text.match(/Number #1:/g)??[]).length,
        last:(text.match(/Number #10:/g)??[]).length,
        items:(text.match(/Number #\d+:/g)??[]).length}
    })
    const state=JSON.stringify(streams)
    if(kind==='mutation'&&state===last)return
    last=state
    const atMs=performance.now()
    rows.push({run,kind,atMs:Math.round(atMs),elapsedMs:Math.round(atMs-started),
      visibility:document.visibilityState,streams})
  }
  document.addEventListener('click',event=>{
    const target=event.target
    if(!(target instanceof Element)||!target.closest('#streamed-results button'))return
    run++;started=performance.now();last='';record('click')
  },true)
  const observer=new MutationObserver(()=>record('mutation'))
  observer.observe(document,{subtree:true,childList:true,characterData:true})
  addEventListener('pagehide',()=>observer.disconnect(),{once:true})
  Object.defineProperty(globalThis,'__nativeStreamObservation',{value:rows})
}
