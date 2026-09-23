import {fileURLToPath,URL as FileURL} from 'node:url'

function filePath(value){
  if(typeof FileURL==='function'&&value instanceof FileURL)value=fileURLToPath(value)
  if(Buffer.isBuffer(value))value=value.toString()
  if(typeof value!=='string'||value.includes('\0'))throw Object.assign(new TypeError('Expected a path string, Buffer or file URL without null bytes'),{code:typeof value==='string'?'ERR_INVALID_ARG_VALUE':'ERR_INVALID_ARG_TYPE'})
  return value
}
function pathArguments(method,args){
  const converted=[...args];converted[0]=filePath(converted[0])
  if(method==='rename'||method==='copyFile'||method==='symlink')converted[1]=filePath(converted[1])
  return converted
}
