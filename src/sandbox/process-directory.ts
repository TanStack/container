import {validateWorkspacePath,type WorkspaceFiles} from './files'

// Preserve '..' until filesystem resolution so symlink traversal keeps its meaning.
export function processPath(cwd:string,input:unknown):string{
  if(typeof input!=='string')throw Object.assign(new TypeError('Expected a directory or file path'),{code:'ERR_INVALID_ARG_TYPE'})
  try{validateWorkspacePath(input)}catch(error){
    if(error instanceof Error){const code=/^(EINVAL|ENAMETOOLONG):/.exec(error.message)?.[1];if(code)Object.assign(error,{code})}
    throw error
  }
  if(!input)throw Object.assign(Error('ENOENT: empty path'),{code:'ENOENT'})
  return input.startsWith('/')?input:cwd.replace(/\/$/,'')+'/'+input
}
export function processDirectory(fs:WorkspaceFiles,input:unknown,base='/'):string{
  try{
    const path=processPath(base,input)
    const resolved=fs.realpathSync(path)
    if(!fs.isDirectorySync(resolved))throw Object.assign(Error('ENOTDIR: '+path),{code:'ENOTDIR'})
    return resolved
  }catch(error){
    if(error instanceof Error){const code=/^(ENOENT|ENOTDIR|EACCES|EINVAL|ELOOP|ENAMETOOLONG):/.exec(error.message)?.[1];if(code)Object.assign(error,{code})}
    throw error
  }
}
export function processFileArguments(cwd:string,method:string,args:unknown[]):unknown[]{
  const result=[...args]
  result[0]=processPath(cwd,result[0])
  // A relative symlink target is stored verbatim, not resolved against cwd.
  if(method==='rename'||method==='copyFile')result[1]=processPath(cwd,result[1])
  return result
}

export function watchEventFilename(directory:string,eventPath:string):string{
  const prefix=directory==='/'?'/':directory+'/'
  return eventPath.slice(prefix.length)
}
