const fail=(code,message)=>{throw Object.assign(new TypeError(message),{code})}
const optionLabel=(raw,type)=>type==='string'?`${raw} <value>`:raw

/** A bounded implementation of Node's ordinary command-line argument parser. */
export function parseArgs(config={}){
  if(config===null||typeof config!=='object'||Array.isArray(config))fail('ERR_INVALID_ARG_TYPE','The "config" argument must be of type object')
  const args=config.args===undefined?process.argv.slice(2):config.args
  const definitions=config.options??{},strict=config.strict!==false,allowPositionals=config.allowPositionals??!strict,tokensEnabled=config.tokens===true,allowNegative=config.allowNegative===true
  if(!Array.isArray(args)||args.some(value=>typeof value!=='string'))fail('ERR_INVALID_ARG_TYPE','The "args" argument must be an array of strings')
  if(!definitions||typeof definitions!=='object'||Array.isArray(definitions))fail('ERR_INVALID_ARG_TYPE','The "options" argument must be of type object')
  const short=new Map(),values=Object.create(null),assigned=new Set(),positionals=[],tokens=[]
  for(const [name,definition] of Object.entries(definitions)){
    if(!definition||typeof definition!=='object'||Array.isArray(definition)||(definition.type!=='string'&&definition.type!=='boolean'))fail('ERR_INVALID_ARG_TYPE',`Option '${name}' must declare type 'string' or 'boolean'`)
    if(definition.short!==undefined){if(typeof definition.short!=='string'||definition.short.length!==1)fail('ERR_INVALID_ARG_VALUE',`Option '${name}' short flag must be one character`);short.set(definition.short,name)}
    if(definition.default!==undefined)values[name]=structuredClone(definition.default)
  }
  const assign=(name,definition,value)=>{
    if(definition.multiple){if(!assigned.has(name))values[name]=[];values[name].push(value)}
    else values[name]=value
    assigned.add(name)
  }
  const readOption=(name,raw,index,inlineValue)=>{
    let definition=definitions[name]
    if(!definition){if(strict)fail('ERR_PARSE_ARGS_UNKNOWN_OPTION',`Unknown option '${raw}'`);definition={type:'boolean'}}
    let value,inline
    if(definition.type==='string'){
      if(inlineValue!==undefined){value=inlineValue;inline=true}
      else {value=args[index+1];if(value===undefined||value.startsWith('-'))fail('ERR_PARSE_ARGS_INVALID_OPTION_VALUE',`Option '${optionLabel(raw,'string')}' argument missing`);inline=false}
    }else{
      if(inlineValue!==undefined)fail('ERR_PARSE_ARGS_INVALID_OPTION_VALUE',`Option '${raw}' does not take an argument`)
      value=true
    }
    assign(name,definition,value)
    tokens.push({kind:'option',name,rawName:raw,index,value:definition.type==='boolean'?undefined:value,inlineValue:definition.type==='boolean'?undefined:inline})
    return definition.type==='string'&&!inline?1:0
  }
  let terminated=false
  for(let index=0;index<args.length;index++){
    const argument=args[index]
    if(terminated){positionals.push(argument);tokens.push({kind:'positional',index,value:argument});continue}
    if(argument==='--'){terminated=true;tokens.push({kind:'option-terminator',index});continue}
    if(argument.startsWith('--')&&argument.length>2){
      const equals=argument.indexOf('='),raw=equals<0?argument:argument.slice(0,equals),inputName=raw.slice(2),inline=equals<0?undefined:argument.slice(equals+1)
      if(allowNegative&&inputName.startsWith('no-')&&inline===undefined){const name=inputName.slice(3),definition=definitions[name];if(definition?.type==='boolean'){assign(name,definition,false);tokens.push({kind:'option',name,rawName:raw,index,value:undefined,inlineValue:undefined});continue}}
      index+=readOption(inputName,raw,index,inline);continue
    }
    if(argument.startsWith('-')&&argument!=='-'){
      for(let offset=1;offset<argument.length;offset++){
        const flag=argument[offset],name=short.get(flag)??flag,definition=definitions[name],raw='-'+flag
        if(!definition&&strict)fail('ERR_PARSE_ARGS_UNKNOWN_OPTION',`Unknown option '${raw}'`)
        if(definition?.type==='string'){
          const remainder=argument.slice(offset+1),consumed=readOption(name,raw,index,remainder||undefined);index+=consumed;break
        }
        readOption(name,raw,index,undefined)
      }
      continue
    }
    if(!allowPositionals)fail('ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',`Unexpected argument '${argument}'. This command does not take positional arguments`)
    positionals.push(argument);tokens.push({kind:'positional',index,value:argument})
  }
  return tokensEnabled?{values,positionals,tokens}:{values,positionals}
}
