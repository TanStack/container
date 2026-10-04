import {expect,it,vi} from 'vitest'
import {runNativeAgentCommand} from '../src/native/agent-command'
it('waits for command cleanup when the input callback fails',async()=>{
  let finish!:(value:any)=>void
  const reason=Error('input setup failed'),interrupt=vi.fn(),done=vi.fn()
  const command={result:new Promise<any>(resolve=>{finish=resolve}),writeInput:vi.fn(),endInput:vi.fn(),interrupt,resize:vi.fn()}
  const running=runNativeAgentCommand({terminalCommand:vi.fn(),openTerminalCommand:()=>command},
    {command:'node',cwd:'/app'},{onInput:()=>{throw reason}})
  const observed=running.catch(error=>{done();return error})
  await Promise.resolve();await Promise.resolve()
  expect(interrupt).toHaveBeenCalledOnce()
  expect(done).not.toHaveBeenCalled()
  finish({exitCode:1,cwd:'/app',changedPaths:[]})
  expect(await observed).toBe(reason)
})
it('passes command-local environment values literally and validates names',async()=>{
  const terminalCommand=vi.fn(async()=>({exitCode:0,cwd:'/app',changedPaths:[],stdout:'',stderr:''}))
  await runNativeAgentCommand({terminalCommand},{command:'node',cwd:'/app',env:{VALUE:"a'b $(echo nope)"}})
  expect(terminalCommand.mock.calls[0][0]).toBe(`VALUE='a'"'"'b $(echo nope)' 'node'`)
  for(const env of [{'bad-name':'x'},{VALUE:'bad\0value'},{VALUE:1}])await expect(runNativeAgentCommand({terminalCommand},{command:'node',cwd:'/app',env:env as never})).rejects.toThrow('environment')
  expect(terminalCommand).toHaveBeenCalledOnce()
})
it('suppresses output after cancellation and rejects a late successful completion',async()=>{
  let finish!: (value:any)=>void
  let emit!: (text:string,stream:'stdout'|'stderr')=>void
  const controller=new AbortController(),reason=Error('cancel'),output=vi.fn()
  const terminalCommand=vi.fn((_line:string,_cwd:string,onOutput:any,signal?:AbortSignal)=>{
    expect(signal).toBe(controller.signal)
    emit=onOutput
    return new Promise<any>(resolve=>{finish=resolve})
  })
  const pending=runNativeAgentCommand({terminalCommand},{command:'node',cwd:'/app'},{signal:controller.signal,onOutput:output})
  emit('before','stdout')
  controller.abort(reason)
  emit('late','stderr')
  finish({exitCode:0,cwd:'/app',changedPaths:[]})
  await expect(pending).rejects.toBe(reason)
  emit('later','stdout')
  expect(output.mock.calls).toEqual([['before','stdout']])
})
it('propagates transport failure and ignores output after settlement',async()=>{
  let emit!: (text:string,stream:'stdout'|'stderr')=>void
  const reason=Error('transport failed'),output=vi.fn()
  const terminalCommand=vi.fn(async(_line:string,_cwd:string,onOutput:any)=>{emit=onOutput;throw reason})
  await expect(runNativeAgentCommand({terminalCommand},{command:'node',cwd:'/app'},{onOutput:output})).rejects.toBe(reason)
  emit('late','stdout')
  expect(output).not.toHaveBeenCalled()
})
it('quotes every argument literally and captures streams with one byte budget',async()=>{
  const terminalCommand=vi.fn(async(line:string,cwd:string,output:any)=>{
    output('out','stdout');output('error','stderr')
    return {cwd,stdout:'out',stderr:'error',exitCode:7,changedPaths:[]}
  })
  const output=vi.fn()
  expect(await runNativeAgentCommand({terminalCommand},{command:'node',args:['a b',"a'b",'$(echo nope)',''],cwd:'/app'},{maxOutputBytes:5,onOutput:output})).toEqual({stdout:'out',stderr:'er',truncated:true,status:7,cwd:'/app',changedPaths:[]})
  expect(terminalCommand.mock.calls[0][0]).toBe(`'node' 'a b' 'a'"'"'b' '$(echo nope)' ''`)
  expect(output.mock.calls).toEqual([['out','stdout'],['error','stderr']])
})
it('rejects invalid inputs and pre-aborted calls before dispatch',async()=>{
  const terminalCommand=vi.fn(),backend={terminalCommand}
  for(const input of [{command:'',cwd:'/app'},{command:'node',args:['bad\0arg'],cwd:'/app'},{command:'node',cwd:'/app/../outside'},{command:'node',args:['x'.repeat(8192)],cwd:'/app'}])await expect(runNativeAgentCommand(backend,input)).rejects.toThrow()
  const controller=new AbortController(),reason=Error('cancel');controller.abort(reason)
  await expect(runNativeAgentCommand(backend,{command:'node',cwd:'/app'},{signal:controller.signal})).rejects.toBe(reason)
  expect(terminalCommand).not.toHaveBeenCalled()
  await expect(runNativeAgentCommand(backend,{command:'node',args:'not an array' as never,cwd:'/app'})).rejects.toThrow('must be an array')
})
