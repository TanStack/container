import type {ProjectInstallOptions,ProjectInstallResult} from '../npm/project'
import type {KernelProcessHandle} from '../sandbox/kernel'
import type {SpawnOptions} from '../sandbox/guest-processes'

export interface ProjectCommandKernel {
  readText(path:string):Promise<string>
  install(options?:ProjectInstallOptions,signal?:AbortSignal):Promise<ProjectInstallResult>
  spawn(command:string,args?:string[],options?:SpawnOptions):Promise<KernelProcessHandle>
  spawnShell(script:string,options?:SpawnOptions):Promise<KernelProcessHandle>
}

export interface InstallProjectCommandOptions extends ProjectInstallOptions {signal?:AbortSignal}
export interface SpawnProjectCommandOptions extends SpawnOptions {cwd?:string}

const managers='(?:npm|pnpm|yarn|bun)'
const installCommand=new RegExp(`^${managers}\\s+(?:install|i|ci)(?:\\s+(?:--(?:ignore-scripts|no-audit|no-fund|frozen-lockfile|prefer-offline|offline|silent)))*\\s*$`)
const runCommand=new RegExp(`^(npm|pnpm|yarn|bun)\\s+(?:(?:run|run-script)\\s+)?([A-Za-z0-9:_-]+)(?:\\s+--)?(?:\\s+([\\s\\S]*))?$`)

const shellQuote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'"
const directory=(value:string|undefined)=>{
  const cwd=value??'/project'
  if(!cwd.startsWith('/')||cwd.includes('\0'))throw Object.assign(Error('Invalid project command cwd'),{code:'EINVAL'})
  return cwd==='/'?'':cwd.replace(/\/$/,'')
}
const manifestOf=async(kernel:ProjectCommandKernel,cwd:string)=>{
  let value:unknown
  try{value=JSON.parse(await kernel.readText((cwd||'')+'/package.json'))}catch(error){throw Object.assign(Error('Could not read project package.json: '+String(error)),{code:'EINVAL'})}
  if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(Error('Invalid project package.json'),{code:'EINVAL'})
  return value as Record<string,unknown>
}
const scriptsOf=(manifest:Record<string,unknown>)=>manifest.scripts&&typeof manifest.scripts==='object'&&!Array.isArray(manifest.scripts)?manifest.scripts as Record<string,unknown>:{}
const lifecycleEnvironment=(script:string,event:string,cwd:string,manifest:Record<string,unknown>)=>{
  const env:Record<string,string>={INIT_CWD:cwd||'/',npm_lifecycle_event:event,npm_lifecycle_script:script,npm_package_json:(cwd||'')+'/package.json'}
  if(typeof manifest.name==='string')env.npm_package_name=manifest.name
  if(typeof manifest.version==='string')env.npm_package_version=manifest.version
  return env
}
const lifecycle=(script:string,event:string,cwd:string,manifest:Record<string,unknown>,command=script)=>{
  const env=lifecycleEnvironment(script,event,cwd,manifest)
  const exports=Object.entries(env).map(([key,value])=>`export ${key}=${shellQuote(value)}`).join('; ')
  return `(${exports}; ${command})`
}

/** Run the SDK installer for a declared npm-compatible install command. */
export async function installProjectCommand(kernel:ProjectCommandKernel,command:string,{signal,...options}:InstallProjectCommandOptions={}):Promise<ProjectInstallResult>{
  const declared=typeof command==='string'?command.trim():''
  if(!installCommand.test(declared))throw Object.assign(Error('Unsupported project install command: '+command),{code:'ERR_UNSUPPORTED_OPERATION'})
  return kernel.install({...options,...(declared.split(/\s+/).includes('--ignore-scripts')?{ignoreScripts:true}:{})},signal)
}

/**
 * Start a declared project command as a long-lived shell process. npm, pnpm,
 * yarn, and bun run commands resolve package.json scripts without requiring a
 * package-manager binary in the guest. Other commands run unchanged.
 */
export async function spawnProjectCommand(kernel:ProjectCommandKernel,command:string,options:SpawnProjectCommandOptions={}):Promise<KernelProcessHandle>{
  if(typeof command!=='string'||!command.trim()||command.includes('\0'))throw Object.assign(Error('Invalid project command'),{code:'EINVAL'})
  const cwd=directory(options.cwd),match=runCommand.exec(command.trim())
  if(!match)return kernel.spawnShell(command,options)
  const [,manager,name,argumentText='']=match
  if(['install','i','ci'].includes(name))throw Object.assign(Error('Use installProjectCommand for package installation'),{code:'ERR_UNSUPPORTED_OPERATION'})
  if(manager==='npm'&&!['start','stop','restart','test'].includes(name)&&!/^npm\s+(?:run|run-script)\s+/.test(command.trim()))return kernel.spawnShell(command,options)
  const manifest=await manifestOf(kernel,cwd),scripts=scriptsOf(manifest),script=scripts[name]
  if(typeof script!=='string'||!script.trim())throw Object.assign(Error('No package script named '+name),{code:'ENOENT'})
  const before=scripts['pre'+name],after=scripts['post'+name]
  const direct=/^[A-Za-z0-9_./:@=+-]+(?:\s+[A-Za-z0-9_./:@=+-]+)*$/.test(script.trim())
  if(direct&&!(typeof before==='string'&&before.trim())&&!(typeof after==='string'&&after.trim())){
    const [executable,...args]=script.trim().split(/\s+/)
    if(argumentText)args.push(...argumentText.trim().split(/\s+/))
    return kernel.spawn(executable,args,{...options,env:{...options.env,...lifecycleEnvironment(script,name,cwd,manifest)}})
  }
  const sequence:string[]=[]
  if(typeof before==='string'&&before.trim())sequence.push(lifecycle(before,'pre'+name,cwd,manifest))
  sequence.push(lifecycle(script,name,cwd,manifest,script+(argumentText?' '+argumentText:'')))
  if(typeof after==='string'&&after.trim())sequence.push(lifecycle(after,'post'+name,cwd,manifest))
  return kernel.spawnShell(sequence.join(' && '),options)
}
