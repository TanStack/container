const requireValue=(condition,message)=>{if(!condition)throw Error(message)}

export const nativeOwnerSoakCycles=10

export function checkNativeOwnerSoak(rows,errors=[]){
  requireValue(Array.isArray(rows)&&rows.length===nativeOwnerSoakCycles,'Incomplete owner soak')
  requireValue(Array.isArray(errors)&&errors.length===0,'Owner soak browser errors')
  for(const [index,row] of rows.entries()){
    requireValue(row.cycle===index+1,'Owner soak cycle order changed')
    for(const key of ['http','filesystem','shellState','node','stdin','interrupt','replacement','freshSession','freshProject'])
      requireValue(row[key]===true,'Owner soak failed '+key+' in cycle '+row.cycle)
    requireValue(row.running===false&&row.commands===0,'Disposed owner retained work')
    requireValue(row.resources?.running===false&&row.resources?.starting===false&&row.resources?.installing===false&&
      ['commands','terminalSessions','responseStreams','sockets','mutations'].every(key=>row.resources[key]===0),
      'Disposed owner retained resources')
    requireValue(Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0,'Invalid owner soak timing')
  }
  return {cycles:rows.length,passed:true}
}

// This browser workload keeps one client, owner frame and document for every cycle.
export async function runNativeOwnerSoak(client,onCycle=()=>{}){
  const rows=[]
  const verify=(condition,message)=>requireValue(condition,message)
  const text=bytes=>new TextDecoder().decode(bytes)
  const success=(result,expected)=>verify(result.exitCode===0&&result.stdout===expected&&!result.stderr,
    'Terminal result differs: '+JSON.stringify(result))
  for(let cycle=1;cycle<=nativeOwnerSoakCycles;cycle++){
    const started=performance.now(),marker='cycle-'+cycle
    const row={cycle}
    try{
      const port=await client.start({
        '/app/package.json':'{"type":"module"}',
        '/app/server.mjs':`export default {fetch(){return new Response(${JSON.stringify(marker)})}}`,
        '/app/done.cjs':`process.stdout.write(${JSON.stringify(marker+'\n')});`,
        '/app/wait.cjs':'process.stdout.write("ready\\n");setInterval(()=>{},1000);',
        '/app/input.cjs':'let value="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>value+=chunk);process.stdin.on("end",()=>process.stdout.write(value));',
      },{entry:'server.mjs',serveFetchEntry:true,installDependencies:false})
      const response=await client.fetch(new Request('http://127.0.0.1:'+port+'/identity'))
      verify(response.status===200&&await response.text()===marker,'Project HTTP identity differs')
      row.http=true
      verify(!(await client.listDirectory('/app')).some(file=>file.name==='identity.txt'),'Previous project files survived replacement')
      row.freshProject=true
      const session=await client.openTerminalSession('/app')
      try{
        success(await session.runCommand(`value=${marker}; printf '%s\\n' "$value" > identity.txt`).result,'')
        verify(text(await client.readFile('/app/identity.txt'))===marker+'\n','Shell write did not reach owner filesystem')
        row.filesystem=true
        success(await session.runCommand('printf "%s\\n" "$value"; cat identity.txt').result,marker+'\n'+marker+'\n')
        row.shellState=true
        success(await session.runCommand('node done.cjs').result,marker+'\n')
        row.node=true
        const input=session.runCommand('node input.cjs')
        input.writeInput(marker+'\n');input.endInput()
        success(await input.result,marker+'\n')
        row.stdin=true
        let readyResolve,readyReject,readyOutput=''
        const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject})
        const timer=setTimeout(()=>readyReject(Error('Interrupted command did not become ready')),30000)
        const waiting=session.runCommand('node wait.cjs',chunk=>{
          readyOutput+=chunk
          if(readyOutput.includes('ready\n'))readyResolve()
        })
        waiting.result.catch(readyReject)
        try{
          await ready
          verify((await client.resources()).commands===1,'Owner did not count active foreground work')
          waiting.interrupt()
          verify((await waiting.result).exitCode===130,'Interrupt did not preserve shell exit status')
          row.interrupt=true
        }finally{clearTimeout(timer)}
        success(await session.runCommand('node done.cjs').result,marker+'\n')
        verify((await client.resources()).commands===0,'Replacement command stayed active')
        row.replacement=true
      }finally{await session.dispose()}
      const fresh=await client.openTerminalSession('/app')
      try{
        success(await fresh.runCommand('printf "fresh:%s\\n" "$value"; cat identity.txt').result,'fresh:\n'+marker+'\n')
        row.freshSession=true
      }finally{await fresh.dispose()}
      await client.dispose()
      const resources=await client.resources()
      row.resources=resources;row.running=resources.running;row.commands=resources.commands
      verify(!resources.running&&!resources.starting&&!resources.installing&&
        ['commands','terminalSessions','responseStreams','sockets','mutations'].every(key=>resources[key]===0),
        'Project disposal retained work')
      row.elapsedMs=Math.round(performance.now()-started)
      rows.push(row);await onCycle(row)
    }catch(error){
      row.error=String(error);row.elapsedMs=Math.round(performance.now()-started)
      rows.push(row);await onCycle(row)
      throw Object.assign(Error('Owner soak failed at cycle '+cycle+': '+String(error)),{rows,cause:error})
    }
  }
  checkNativeOwnerSoak(rows)
  return rows
}
