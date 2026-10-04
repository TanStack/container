import process from 'process/browser'
type WorkspaceImporter=(specifier:string)=>Promise<unknown>
let workspaceImporter:WorkspaceImporter|undefined

export function setRuntimeWorkspaceImporter(importer:WorkspaceImporter){workspaceImporter=importer}

/** Route toolchain-generated workspace imports through the project loader. */
export function importRuntimeModule(specifier:string,options?:unknown):Promise<unknown>{
  const value=String(specifier)
  const trace=process.env.NATIVE_MODULE_TRACE==='1'
  const label=value.startsWith('/app/')||value.startsWith('file:')?value:'browser-module'
  if(trace)globalThis.postMessage({type:'native-dev-progress',phase:`runtime-import-start:${label}`})
  if(value.startsWith('/app/')||value.startsWith('file:')){
    if(!workspaceImporter)return Promise.reject(Error('Workspace module importer is unavailable'))
    if(options!==undefined)return Promise.reject(Error('Workspace import attributes are not supported'))
    const result=workspaceImporter(value)
    if(!trace)return result
    return result.then(module=>{
      globalThis.postMessage({type:'native-dev-progress',phase:`runtime-import-end:${label}`})
      return module
    })
  }
  return import(/* @vite-ignore */ value)
}
