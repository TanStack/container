// mkdir is the atomic admission step. Never check existence before creating.
function createMkdtempAPI({mkdir,filePath,Buffer,randomBytes}) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const prepare=(prefix,options)=>{
    prefix=filePath(prefix)
    if(options!==undefined&&options!==null&&typeof options!=='string'&&typeof options!=='object')throw Object.assign(new TypeError('Expected encoding options'),{code:'ERR_INVALID_ARG_TYPE'})
    const encoding=(typeof options==='string'?options:options?.encoding)??'utf8'
    if(encoding!=='buffer'&&!Buffer.isEncoding(encoding))throw Object.assign(new TypeError('Unknown encoding: '+encoding),{code:'ERR_INVALID_ARG_VALUE'})
    return {prefix,encoding}
  }
  const create=({prefix,encoding})=>{
    for(let attempt=0;attempt<128;attempt++){
      // Rejection sampling avoids modulo bias. Each attempt uses fixed entropy.
      let suffix=''
      for(const byte of randomBytes(16)){if(byte<248)suffix+=alphabet[byte%62];if(suffix.length===6)break}
      if(suffix.length!==6)continue
      const name=prefix+suffix
      try{mkdir(name,{mode:0o700})}catch(error){if(error.code==='EEXIST')continue;throw error}
      const bytes=Buffer.from(name)
      return encoding==='buffer'?bytes:bytes.toString(encoding)
    }
    throw Object.assign(new Error('Unable to create a unique temporary directory'),{code:'EEXIST'})
  }
  return {prepare,create}
}
