import path from 'path-browserify'

// One owner-side operation. Check the current namespace for every write, then
// create parents and write using the same public filesystem methods as before.
export function writeFileWithParents(fs,filename,contents,options={}){
  if(typeof filename!=='string'||!filename.startsWith('/')||filename.includes('\0'))
    throw TypeError('File path must be an absolute path without null bytes')
  const target=path.resolve('/',filename)
  if(target==='/')throw Error('Cannot write a file at the workspace root')
  if(options.followSymlinks===false){
    let current=''
    for(const segment of target.split('/').filter(Boolean)){
      current+='/'+segment
      try{
        if(fs.lstatSync(current).isSymbolicLink())throw Error('Refusing to write through a symbolic link: '+current)
      }catch(error){if(error.code!=='ENOENT')throw error}
    }
  }
  fs.mkdirSync(path.dirname(target),{recursive:true})
  fs.writeFileSync(target,contents,options.mode===undefined?undefined:{mode:options.mode})
}
