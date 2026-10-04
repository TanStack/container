import path from 'path-browserify'

function within(value:string,root:string){return value===root||value.startsWith(root+'/')}
function absolute(value:string){
  if(typeof value!=='string'||!value.startsWith('/')||value.includes('\0'))throw Error('Invalid terminal working directory')
  return path.normalize(value)
}
export function toShellDirectory(value:string){
  const cwd=absolute(value)
  if(within(cwd,'/app'))return '/project'+cwd.slice('/app'.length)
  if(within(cwd,'/tmp'))return cwd
  throw Error('Terminal working directory is outside the container')
}
export function fromShellDirectory(value:string){
  const cwd=absolute(value)
  if(within(cwd,'/project'))return '/app'+cwd.slice('/project'.length)
  if(within(cwd,'/tmp'))return cwd
  throw Error('Shell returned a working directory outside the container')
}
