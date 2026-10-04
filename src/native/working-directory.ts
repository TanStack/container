import path from 'path-browserify'

export function assertCanChangeDirectory(workerThread:boolean){
  if(workerThread)throw Object.assign(Error('process.chdir() is not supported in workers'),{code:'ERR_WORKER_UNSUPPORTED_OPERATION'})
}

export function resolveWorkingDirectory(current:string,directory:string,
  filesystem:{statSync(path:string):{isDirectory():boolean}}):string{
  if(typeof directory!=='string')throw Object.assign(new TypeError('Directory must be a string'),{code:'ERR_INVALID_ARG_TYPE'})
  const next=path.resolve(current,directory)
  if(!['/app','/tmp'].some(root=>next===root||next.startsWith(root+'/')))
    throw Object.assign(Error('Cannot leave the container filesystem'),{code:'ERR_OUTSIDE_CONTAINER_PATH'})
  if(!filesystem.statSync(next).isDirectory())
    throw Object.assign(Error(`Not a directory: ${next}`),{code:'ENOTDIR'})
  return next
}
