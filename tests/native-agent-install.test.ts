import {expect,it,vi} from 'vitest'
import {installNativeAgentProject} from '../src/native/agent-install'
it('returns actual committed results and forwards output and cancellation',async()=>{
  const committed={installed:1,skippedPlatformPackages:['native'],ignoredScripts:['/']}
  const terminalCommand=vi.fn(async()=>({exitCode:0,cwd:'/app',stdout:'',stderr:'',changedPaths:[]})),installResult=vi.fn(async()=>committed)
  const controller=new AbortController(),output=vi.fn()
  expect(await installNativeAgentProject({terminalCommand,installResult},'/app',{signal:controller.signal,onOutput:output})).toBe(committed)
  expect(terminalCommand).toHaveBeenCalledWith('npm install','/app',output,controller.signal)
})
it('never reports stale results after a failed or cancelled install',async()=>{
  const controller=new AbortController(),reason=Error('cancel')
  const terminalCommand=vi.fn(async()=>({exitCode:1,cwd:'/app',stdout:'',stderr:'failed',changedPaths:[]})),installResult=vi.fn()
  await expect(installNativeAgentProject({terminalCommand,installResult},'/app')).rejects.toMatchObject({code:'ERR_INSTALL_FAILED'})
  terminalCommand.mockImplementationOnce(async()=>{controller.abort(reason);return {exitCode:0,cwd:'/app',stdout:'',stderr:'',changedPaths:[]}})
  await expect(installNativeAgentProject({terminalCommand,installResult},'/app',{signal:controller.signal})).rejects.toBe(reason)
  expect(installResult).not.toHaveBeenCalled()
})
