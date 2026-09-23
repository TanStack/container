import type {WorkspaceFiles} from './files'
import {processPath} from './process-directory'

/** Interpreter arguments are readable source files, not executable commands. */
export function resolveProcessEntry(files:WorkspaceFiles,cwd:string,command:string,interpreter:boolean):string{
  const fail=(code:string,message:string)=>Object.assign(Error(message),{code})
  const requested=processPath(cwd,command)
  const candidates=interpreter&&!/\.[^/]+$/.test(requested)
    ? [requested,requested+'.js',requested+'.mjs',requested+'.cjs']
    : [requested]
  let entry:string|undefined
  for(const candidate of candidates){
    try{
      const resolved=files.realpathSync(candidate)
      if(files.isFileSync(resolved)){entry=resolved;break}
    }catch(error){
      if((error as {code?:string}).code!=='ENOENT')throw error
    }
  }
  if(!entry)throw fail('ENOENT','Executable not found')
  if(!interpreter&&!(files.statSync(entry).mode&0o111))throw fail('EACCES','Executable permission denied: '+command)
  if(!interpreter&&!/\.[cm]?js$/.test(entry)&&!/^#!\s*(?:\/usr\/bin\/env\s+node|\/(?:usr\/)?bin\/node)(?:\s|$)/.test(new TextDecoder().decode(files.readFileSync(entry).subarray(0,128))))throw fail('ENOEXEC','Only JavaScript executables are supported')
  return entry
}
