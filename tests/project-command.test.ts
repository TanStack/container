import {describe,expect,it,vi} from 'vitest'
import {installProjectCommand,spawnProjectCommand,type ProjectCommandKernel} from '../src/sdk/project-command'
import type {KernelProcessHandle} from '../src/sandbox/kernel'

const process={pid:1} as KernelProcessHandle
const fixture=(scripts:Record<string,string>={})=>{
  const install=vi.fn(async(_options?:unknown,_signal?:AbortSignal)=>({installed:3,skippedPlatformPackages:[],ignoredScripts:[]}))
  const spawn=vi.fn(async(_command:string,_args?:string[],_options?:unknown)=>process)
  const spawnShell=vi.fn(async(_script:string,_options?:unknown)=>process)
  const readText=vi.fn(async(_path:string)=>JSON.stringify({name:"project's-name",version:'1.2.3',scripts}))
  return {kernel:{install,spawn,spawnShell,readText} as ProjectCommandKernel,install,spawn,spawnShell,readText}
}

describe('declared project commands',()=>{
  it.each(['npm install','npm ci --ignore-scripts --no-audit','pnpm install --frozen-lockfile','yarn install','bun i --silent'])('routes %s through the transactional SDK installer',async command=>{
    const {kernel,install}=fixture()
    await expect(installProjectCommand(kernel,command,{cwd:'/project'})).resolves.toMatchObject({installed:3})
    expect(install).toHaveBeenCalledWith({cwd:'/project',...(command.includes('--ignore-scripts')?{ignoreScripts:true}:{})},undefined)
  })

  it('rejects package mutation commands that the installer cannot represent',async()=>{
    const {kernel,install}=fixture()
    await expect(installProjectCommand(kernel,'pnpm add react')).rejects.toMatchObject({code:'ERR_UNSUPPORTED_OPERATION'})
    expect(install).not.toHaveBeenCalled()
  })

  it('runs direct declared commands unchanged as long-lived shell processes',async()=>{
    const {kernel,spawnShell,readText}=fixture()
    const options={cwd:'/project',writable:true,lifetime:'session' as const}
    await expect(spawnProjectCommand(kernel,'node server',options)).resolves.toBe(process)
    expect(spawnShell).toHaveBeenCalledWith('node server',options)
    expect(readText).not.toHaveBeenCalled()
  })

  it.each(['pnpm run dev','pnpm dev','npm run dev','yarn dev','bun run dev'])('resolves %s through package.json without a guest package-manager binary',async command=>{
    const {kernel,spawnShell,readText}=fixture({predev:'node prepare.mjs',dev:'vite --host 0.0.0.0',postdev:'node cleanup.mjs'})
    const options={cwd:'/project',writable:true,lifetime:'session' as const}
    await spawnProjectCommand(kernel,command,options)
    expect(readText).toHaveBeenCalledWith('/project/package.json')
    const script=spawnShell.mock.calls[0][0]
    expect(script).toContain("npm_lifecycle_event='predev'")
    expect(script).toContain('node prepare.mjs')
    expect(script).toContain("npm_lifecycle_event='dev'")
    expect(script).toContain('vite --host 0.0.0.0')
    expect(script).toContain("npm_package_name='project'\\''s-name'")
    expect(script).toContain("npm_lifecycle_event='postdev'")
    expect(script).toContain('node cleanup.mjs')
    expect(spawnShell).toHaveBeenCalledWith(script,options)
  })

  it('runs simple package scripts directly so long-lived tools retain stdin',async()=>{
    const {kernel,spawn,spawnShell}=fixture({dev:'vite dev'})
    const options={cwd:'/project',env:{CI:'true'},lifetime:'session' as const}
    await spawnProjectCommand(kernel,'pnpm run dev',options)
    expect(spawnShell).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith('vite',['dev'],{
      ...options,
      env:{
        CI:'true',
        INIT_CWD:'/project',
        npm_lifecycle_event:'dev',
        npm_lifecycle_script:'vite dev',
        npm_package_json:'/project/package.json',
        npm_package_name:"project's-name",
        npm_package_version:'1.2.3',
      },
    })
  })

  it('forwards package-script arguments only to the requested script',async()=>{
    const {kernel,spawnShell}=fixture({predev:'node pre.mjs',dev:'vite'})
    await spawnProjectCommand(kernel,'pnpm run dev -- --host 127.0.0.1',{cwd:'/project'})
    const script=spawnShell.mock.calls[0][0]
    expect(script).toContain('vite --host 127.0.0.1')
    expect(script).not.toContain('node pre.mjs --host')
    expect(script).toContain("npm_lifecycle_script='vite'")
  })

  it('reports missing scripts before allocating a process',async()=>{
    const {kernel,spawnShell}=fixture({test:'node test.mjs'})
    await expect(spawnProjectCommand(kernel,'pnpm run dev',{cwd:'/project'})).rejects.toMatchObject({code:'ENOENT'})
    expect(spawnShell).not.toHaveBeenCalled()
  })
})
