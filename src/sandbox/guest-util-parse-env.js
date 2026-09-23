// Matches Node's dotenv parsing, which is deliberately not JavaScript escaping
// or shell expansion. In particular, only double-quoted \\n is expanded.
export function parseEnv(content){
  if(typeof content!=='string')throw Object.assign(new TypeError('The "content" argument must be of type string'),{code:'ERR_INVALID_ARG_TYPE'})
  const result={}
  const text=content.replace(/\r/g,'')
  const trim=value=>value.replace(/^[ \t\n]+|[ \t\n]+$/g,'')
  let cursor=0
  while(cursor<text.length){
    while(/[ \t\n]/.test(text[cursor]??'')&&cursor<text.length)cursor++
    let end=text.indexOf('\n',cursor)
    if(end===-1)end=text.length
    const equals=text.indexOf('=',cursor)
    if(text[cursor]==='#'||equals===-1||equals>=end){cursor=end+1;continue}
    let key=trim(text.slice(cursor,equals))
    cursor=equals+1
    // A literal newline directly after '=' denotes an empty value. Leading
    // spaces or tabs instead invoke Node's whitespace-skipping path.
    if(text[cursor]===' '||text[cursor]==='\t'){
      while(cursor<text.length&&/[ \t\n]/.test(text[cursor]))cursor++
    }
    // Node handles an immediately empty assignment before export-prefix parsing.
    if(cursor<text.length&&text[cursor]!=='\n'&&key.startsWith('export '))key=trim(key.slice(7))
    let value
    const quote=text[cursor]
    const close=quote==='"'||quote==="'"||quote==='`'?text.indexOf(quote,cursor+1):-1
    if(close!==-1){
      value=text.slice(cursor+1,close)
      if(quote==='"')value=value.replace(/\\n/g,'\n')
      end=text.indexOf('\n',close+1)
      if(end===-1)end=text.length
    }else{
      end=text.indexOf('\n',cursor)
      if(end===-1)end=text.length
      const comment=text.indexOf('#',cursor)
      value=trim(text.slice(cursor,comment!==-1&&comment<end?comment:end))
    }
    if(key)result[key]=value
    cursor=end+1
  }
  return result
}
