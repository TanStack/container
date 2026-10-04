import path from 'path-browserify'

export function resolveWorkerProgram(filename:string|URL,cwd:string,evalOption?:unknown){
  if(evalOption){
    if(typeof filename!=='string')throw Object.assign(new TypeError('options.eval must be false when filename is not a string'),{code:'ERR_INVALID_ARG_VALUE'})
    return {entry:resolveWorkerEntry('./[worker eval]',cwd),evalSource:filename}
  }
  return {entry:resolveWorkerEntry(filename,cwd),evalSource:undefined}
}

export function resolveWorkerEntry(filename:string|URL,cwd:string){
  let entry:string
  if(filename instanceof URL){
    if(filename.protocol==='data:')return filename.href
    if(filename.protocol!=='file:'||filename.host||/%2f|%5c/i.test(filename.pathname))throw Error('Worker entry must be a local file URL')
    entry=decodeURIComponent(filename.pathname)
  }else{
    if(typeof filename!=='string')throw new TypeError('Worker filename must be a string or URL')
    if(filename.startsWith('file:'))return resolveWorkerEntry(new URL(filename),cwd)
    if(!filename.startsWith('/')&&!filename.startsWith('./')&&!filename.startsWith('../'))
      throw Object.assign(Error('Worker filename must be absolute or start with ./ or ../'),{code:'ERR_WORKER_PATH'})
    entry=path.resolve(cwd,filename)
  }
  if(entry.includes('\0')||entry.includes('\\')||!['/app/','/tmp/'].some(root=>entry.startsWith(root)))
    throw Error('Worker entry is outside the container filesystem')
  return entry
}
export function workerExecArgv(explicit:string[]|undefined,inherited:string[],command=false):string[]{
  return [...(explicit??(command?[]:inherited))]
}
