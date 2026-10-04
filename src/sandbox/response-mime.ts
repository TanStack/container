import {MIMEType} from 'whatwg-mimetype'

/** Fetch's combined-header MIME extraction, including quoted commas.
 * https://fetch.spec.whatwg.org/#concept-header-extract-mime-type
 */
export function responseMIME(headers:Headers):string{
  const input=headers.get('content-type')
  if(input===null)return ''
  const values:string[]=[]
  let start=0,quoted=false
  for(let index=0;index<input.length;index++){
    const character=input[index]
    if(quoted&&character==='\\'){index++;continue}
    if(character==='"')quoted=!quoted
    else if(character===','&&!quoted){values.push(input.slice(start,index));start=index+1}
  }
  values.push(input.slice(start))
  let selected:MIMEType|null=null,essence:string|null=null,charset:string|null=null
  for(const value of values){
    const candidate=MIMEType.parse(value.replace(/^[\t ]+|[\t ]+$/g,''))
    if(!candidate||candidate.essence==='*/*')continue
    selected=candidate
    if(candidate.essence!==essence){
      charset=candidate.parameters.get('charset')??null
      essence=candidate.essence
    }else if(!candidate.parameters.has('charset')&&charset!==null)candidate.parameters.set('charset',charset)
  }
  return selected?.toString()??''
}
