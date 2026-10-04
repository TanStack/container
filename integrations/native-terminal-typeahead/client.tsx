import * as React from 'react'
import {createRoot} from 'react-dom/client'
import {NativeTerminal} from '@terminal'

function Control(){
  const gate=React.useRef<(() => void)|null>(null)
  const [phase,setPhase]=React.useState('Ready')
  const [received,setReceived]=React.useState('')
  const [commands,setCommands]=React.useState<string[]>([])
  const onCommand:React.ComponentProps<typeof NativeTerminal>['onCommand']=async(line,cwd,onOutput,signal,onControl)=>{
    setCommands(current=>[...current,line])
    const result=(exitCode=0)=>({cwd,exitCode,stdout:'',stderr:'',changedPaths:[]})
    if(line==='history'){
      for(let index=0;index<80;index++)onOutput('HISTORY '+index+'\n')
      return result()
    }
    if(line==='background'){
      await new Promise<void>(resolve=>{
        let index=0
        const timer=setInterval(()=>onOutput('BACKGROUND '+index+++'\n'),30)
        const stop=()=>{clearInterval(timer);resolve()}
        if(signal?.aborted)stop()
        else signal?.addEventListener('abort',stop,{once:true})
      })
      return result(130)
    }
    if(line!=='cat'&&line!=='hold')return result()
    setPhase('Starting '+line)
    await new Promise<void>(resolve=>{gate.current=resolve})
    gate.current=null
    if(signal?.aborted){setPhase('Interrupted');return result(130)}
    if(line==='hold'){setPhase('Finished hold');return result()}
    const finished=new Promise<void>(resolve=>{
      onControl?.({
        writeInput(value){
          const text=typeof value==='string'?value:new TextDecoder().decode(value)
          setReceived(current=>current+text)
          resolve()
        },
        endInput(){resolve()},interrupt(){resolve()},resize(){},
      })
    })
    await finished
    setPhase('Finished cat')
    return result()
  }
  return <main>
    <p role="status">{phase}</p>
    <button onClick={()=>gate.current?.()}>Release command</button>
    <pre aria-label="Received stdin">{received}</pre>
    <pre aria-label="Commands">{JSON.stringify(commands)}</pre>
    <div style={{height:320,width:720}}>
      <NativeTerminal active generation={0} theme="light" onCommand={onCommand}
        onListCommands={async()=>[]} onListDirectory={async()=>[]} />
    </div>
  </main>
}

const container=document.getElementById('root')
if(!container)throw Error('Terminal control container missing')
createRoot(container).render(<Control />)
