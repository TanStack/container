// Shared traversal for synchronous and asynchronous filters. Filesystem actions
// use the same guest capability as the existing fs facade.
export function createCopyAPI(fs,path,convert){
  const failure=(code,message)=>Object.assign(Error(message),{code})
  const missing=target=>{try{return fs.lstatSync(target)}catch(error){if(error.code==='ENOENT'||String(error.message).startsWith('ENOENT:'))return null;throw error}}
  function options(value){
    if(value===undefined)value={}
    if(!value||typeof value!=='object'||Array.isArray(value))throw failure('ERR_INVALID_ARG_TYPE','Expected copy options')
    for(const key of Object.keys(value))if(!['recursive','force','errorOnExist','filter','dereference','verbatimSymlinks','preserveTimestamps','mode'].includes(key))throw failure('ERR_UNSUPPORTED_OPERATION','Unsupported copy option: '+key)
    for(const key of ['recursive','force','errorOnExist','dereference','verbatimSymlinks','preserveTimestamps'])if(value[key]!==undefined&&typeof value[key]!=='boolean')throw failure('ERR_INVALID_ARG_TYPE','Expected boolean '+key)
    if(value.filter!==undefined&&typeof value.filter!=='function')throw failure('ERR_INVALID_ARG_TYPE','Expected copy filter')
    if(value.preserveTimestamps||value.mode!==undefined&&value.mode!==0)throw failure('ERR_UNSUPPORTED_OPERATION','Copy timestamps and nonzero copy modes are unavailable')
    return {force:true,...value}
  }
  function* walk(source,destination,o,ancestors){
    if(o.filter&&!(yield o.filter(source,destination)))return
    const sourceStat=o.dereference?fs.statSync(source):fs.lstatSync(source),destStat=missing(destination)
    if(sourceStat.isDirectory()){
      if(!o.recursive)throw failure('ERR_FS_EISDIR','Recursive copy is required for directories')
      if(destStat&&!destStat.isDirectory())throw failure('ERR_FS_CP_DIR_TO_NON_DIR','Cannot copy directory to non-directory')
      const real=fs.realpathSync(source)
      if(ancestors.has(real))throw failure('ELOOP','Circular directory symlink')
      const next=new Set(ancestors);next.add(real)
      fs.mkdirSync(destination,{recursive:true})
      for(const name of fs.readdirSync(source))yield*walk(path.join(source,name),path.join(destination,name),o,next)
      return
    }
    if(destStat?.isDirectory())throw failure('ERR_FS_CP_NON_DIR_TO_DIR','Cannot copy non-directory to directory')
    if(destStat){
      if(!o.force){if(o.errorOnExist)throw failure('ERR_FS_CP_EEXIST','Destination exists');return}
      if(destStat.isSymbolicLink())throw failure('ERR_UNSUPPORTED_OPERATION','Replacing a destination symlink is unavailable')
    }
    fs.mkdirSync(path.dirname(destination),{recursive:true})
    if(sourceStat.isSymbolicLink()){
      let target=fs.readlinkSync(source)
      if(!o.verbatimSymlinks)target=path.resolve(path.dirname(source),target)
      if(destStat)fs.unlinkSync(destination)
      fs.symlinkSync(target,destination)
    }else if(sourceStat.isFile())fs.copyFileSync(source,destination)
    else throw failure('ERR_UNSUPPORTED_OPERATION','Unsupported copy file type')
  }
  function prepare(source,destination,value){
    const o=options(value)
    source=path.resolve(convert(source));destination=path.resolve(convert(destination))
    if(source===destination||destination.startsWith(source+'/'))throw failure('ERR_FS_CP_EINVAL','Cannot copy a path into itself')
    const existing=missing(destination)
    if(existing&&!existing.isSymbolicLink()&&!fs.lstatSync(source).isSymbolicLink()&&fs.realpathSync(source)===fs.realpathSync(destination))throw failure('ERR_FS_CP_EINVAL','Source and destination identify the same path')
    // Resolve the nearest existing destination ancestor before admitting a
    // directory copy, preventing a symlinked parent from re-entering its source.
    if((o.dereference?fs.statSync(source):fs.lstatSync(source)).isDirectory()){
      let parent=destination,tail=[]
      while(!missing(parent)){tail.unshift(path.basename(parent));const next=path.dirname(parent);if(next===parent)break;parent=next}
      const actual=path.resolve(fs.realpathSync(parent),...tail),real=fs.realpathSync(source)
      if(actual===real||actual.startsWith(real+'/'))throw failure('ERR_FS_CP_EINVAL','Cannot copy a directory into itself')
    }
    return walk(source,destination,o,new Set())
  }
  return {
    cpSync(source,destination,options){const iterator=prepare(source,destination,options);let step=iterator.next();while(!step.done){if(step.value&&typeof step.value.then==='function')throw failure('ERR_INVALID_RETURN_VALUE','Synchronous copy filter returned a Promise');step=iterator.next(step.value)}},
    async cp(source,destination,options){const iterator=prepare(source,destination,options);let step=iterator.next();while(!step.done)step=iterator.next(await step.value)},
  }
}
