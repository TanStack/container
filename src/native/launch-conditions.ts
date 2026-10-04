export function parseLaunchFlags(flags:readonly string[]=[]){
  const conditions:string[]=[]
  const preloads:string[]=[]
  const imports:string[]=[]
  let inputType:'commonjs'|'module'|undefined
  for(let index=0;index<flags.length;index++){
    const flag=flags[index]!
    // The module evaluator already implements synchronous import.meta.resolve,
    // including the parent URL enabled by this Node flag.
    if(flag==='--experimental-import-meta-resolve')continue
    if(flag==='--input-type'||flag.startsWith('--input-type=')){
      const value=flag==='--input-type'?flags[++index]:flag.slice('--input-type='.length)
      if(value!=='module'&&value!=='commonjs')throw Object.assign(Error('Unsupported Node input type: '+value),{code:'ERR_UNSUPPORTED_OPERATION'})
      inputType=value
      continue
    }
    if(flag==='-e'||flag==='--eval'||flag.startsWith('--eval=')){
      if(!flag.startsWith('--eval=')&&flags[++index]===undefined)throw Object.assign(Error(`Incomplete Node eval flag: ${flag}`),{code:'ERR_UNSUPPORTED_OPERATION'})
      continue
    }
    if(flag==='--import'||flag.startsWith('--import=')){
      const preload=flag.startsWith('--import=')?flag.slice('--import='.length):flags[++index]
      if(!preload||preload.startsWith('-'))throw Object.assign(new Error(`Unsupported or incomplete Node launch flag: ${flag}`),{code:'ERR_UNSUPPORTED_OPERATION'})
      imports.push(preload)
      continue
    }
    if(flag==='--require'||flag==='-r'||flag.startsWith('--require=')){
      const preload=flag.startsWith('--require=')?flag.slice('--require='.length):flags[++index]
      if(!preload||preload.startsWith('-'))throw Object.assign(new Error(`Unsupported or incomplete Node launch flag: ${flag}`),{code:'ERR_UNSUPPORTED_OPERATION'})
      preloads.push(preload)
      continue
    }
    const value=flag==='--conditions'||flag==='-C'?flags[++index]:
      flag.startsWith('--conditions=')?flag.slice('--conditions='.length):undefined
    if(value===undefined||value==='')throw Object.assign(new Error(`Unsupported or incomplete Node launch flag: ${flag}`),{code:'ERR_UNSUPPORTED_OPERATION'})
    conditions.push(value)
  }
  return {conditions:[...new Set(conditions)],preloads,...(imports.length?{imports}:{}),...(inputType===undefined?{}:{inputType})}
}
export function launchConditions(flags:readonly string[]=[]):string[]{return parseLaunchFlags(flags).conditions}

export function parseNodeInvocation(args:readonly string[]){
  const execArgv:string[]=[]
  let evalSource:string|undefined
  let index=0
  for(;index<args.length;index++){
    const flag=args[index]!
    if(flag==='--'){index++;break}
    if(flag==='-'||!flag.startsWith('-'))break
    execArgv.push(flag)
    if(flag==='-e'||flag==='--eval'||flag.startsWith('--eval=')){
      evalSource=flag.startsWith('--eval=')?flag.slice('--eval='.length):args[++index]
      if(evalSource===undefined)throw Error(`Incomplete launch flag ${flag}`)
      if(!flag.startsWith('--eval='))execArgv.push(evalSource)
    }else if(['--require','-r','--conditions','-C','--input-type','--import'].includes(flag)){
      const value=args[++index]
      if(value===undefined)throw Error(`Incomplete launch flag ${flag}`)
      execArgv.push(value)
    }
  }
  const flags=parseLaunchFlags(execArgv)
  if(evalSource!==undefined)return {entry:'__native_eval__.cjs',argv:args.slice(index),execArgv,evalSource}
  const entry=args[index]
  if(entry==='-')return {entry:'__native_stdin__.cjs',argv:args.slice(index+1),execArgv,stdinSource:true}
  if(!entry)throw Error('Interactive Node is not supported')
  if(flags.inputType!==undefined)throw Object.assign(Error('--input-type can only be used with eval or stdin'),{code:'ERR_INPUT_TYPE_NOT_ALLOWED'})
  return {entry,argv:args.slice(index+1),execArgv}
}
