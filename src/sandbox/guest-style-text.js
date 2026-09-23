export function styleText(format,text,options){
  const invalid=(name)=>{throw Object.assign(new TypeError('Invalid '+name),{code:'ERR_INVALID_ARG_TYPE'})}
  if(typeof text!=='string')invalid('text')
  if(options!==undefined&&(options===null||typeof options!=='object'||Array.isArray(options)))invalid('options')
  const validateStream=options?.validateStream??true
  if(typeof validateStream!=='boolean')invalid('options.validateStream')
  let colorize=true
  if(validateStream){
    const stream=options?.stream??process.stdout
    if(!stream||!(typeof stream.pipe==='function'||typeof stream.write==='function'||typeof stream.getReader==='function'||typeof stream.getWriter==='function'))invalid('stream')
    const force=process.env.FORCE_COLOR
    colorize=force!==undefined?['','1','true','2','3'].includes(force):!!stream.isTTY&&(typeof stream.getColorDepth!=='function'||stream.getColorDepth()>2)
  }
  let open='',close='',processed=text
  for(const key of Array.isArray(format)?format:[format]){
    if(key==='none')continue
    const codes=typeof key==='string'&&Object.hasOwn(util.inspect.colors,key)?util.inspect.colors[key]:undefined
    if(!codes)throw Object.assign(new TypeError('Unknown text style: '+String(key)),{code:'ERR_INVALID_ARG_VALUE'})
    const begin='\x1b['+codes[0]+'m',end='\x1b['+codes[1]+'m'
    open+=begin;close=end+close
    processed=processed.split(end).join((codes[0]===1||codes[0]===2?end:'')+begin)
  }
  return colorize?open+processed+close:text
}
util.styleText=styleText
