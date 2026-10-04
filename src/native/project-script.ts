export type NativeDevCommand={kind:'vite-dev'}|{kind:'node';entry:string}
export type NativeBuildStep={kind:'vite-build';ssr:boolean}|{kind:'typescript-no-emit'}

/** Validate a declared package-manager install request. Native installation uses the mounted npm lockfile. */
export function parseNativeInstallCommand(source:string){
  const command=source.trim()
  if(!/^(?:npm|pnpm|yarn|bun) (?:install|i|ci)(?: --(?:ignore-scripts|no-audit|no-fund|silent))*$/.test(command))
    throw Object.assign(Error(`Unsupported native install command: ${source}`),{code:'ERR_UNSUPPORTED_OPERATION'})
  return command
}

/** Resolve a package-manager run command to a declared project script name. */
export function parseNativeStartCommand(source:string){
  const match=/^(?:npm|pnpm|yarn|bun) (?:run |run-script )?([A-Za-z0-9:_-]+)$/.exec(source.trim())
  if(!match||['install','i','ci'].includes(match[1]!))
    throw Object.assign(Error(`Unsupported native start command: ${source}`),{code:'ERR_UNSUPPORTED_OPERATION'})
  return match[1]!
}

/** Resolve the supported direct dev commands without invoking a host shell. */
export function parseNativeDevCommand(source:string):NativeDevCommand{
  const command=source.trim()
  if(command==='vite'||command==='vite dev')return {kind:'vite-dev'}
  const node=/^node\s+([^\s]+)$/.exec(command)
  if(node&&!node[1]!.startsWith('-')&&!/[;&|<>$`]/.test(node[1]!))
    return {kind:'node',entry:node[1]!}
  throw Object.assign(Error(`Unsupported native dev command: ${source}`),{code:'ERR_UNSUPPORTED_OPERATION'})
}

export function readNativeDevScript(manifestSource:string,name:string):NativeDevCommand{
  if(!/^[A-Za-z0-9:_-]+$/.test(name))throw Error('Invalid project script name')
  const manifest=JSON.parse(manifestSource) as {scripts?:Record<string,unknown>}
  const command=manifest.scripts?.[name]
  if(typeof command!=='string'||!command.trim())throw Error(`No package script named ${name}`)
  return parseNativeDevCommand(command)
}

/** Resolve supported package build commands before any step is run. */
export function planNativeBuildScript(manifestSource:string,name:string):NativeBuildStep[]{
  const manifest=JSON.parse(manifestSource) as {scripts?:Record<string,unknown>}
  const active=new Set<string>()
  const expand=(scriptName:string):NativeBuildStep[]=>{
    if(!/^[A-Za-z0-9:_-]+$/.test(scriptName))throw Error('Invalid project script name')
    if(active.has(scriptName))throw Error(`Project script cycle: ${scriptName}`)
    const source=manifest.scripts?.[scriptName]
    if(typeof source!=='string'||!source.trim())throw Error(`No package script named ${scriptName}`)
    active.add(scriptName)
    try{
      return source.split(/\s*&&\s*/).flatMap(raw=>{
        const command=raw.trim()
        if(command==='vite build')return [{kind:'vite-build',ssr:false}]
        if(command==='vite build --ssr')return [{kind:'vite-build',ssr:true}]
        if(command==='tsc --noEmit')return [{kind:'typescript-no-emit'}]
        const nested=/^(?:npm|pnpm) run ([A-Za-z0-9:_-]+)$/.exec(command)
        if(nested)return expand(nested[1]!)
        throw Object.assign(Error(`Unsupported native build command: ${command}`),{code:'ERR_UNSUPPORTED_OPERATION'})
      })
    }finally{active.delete(scriptName)}
  }
  return expand(name)
}
