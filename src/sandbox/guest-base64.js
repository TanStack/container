const base64String=value=>{
  if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol value to a string')
  return String(value)
}
const invalidBase64=()=>Object.assign(new Error('Invalid character'),{name:'InvalidCharacterError',code:5})
export function btoa(value){
  if(!arguments.length)throw Object.assign(new TypeError('One argument is required'),{code:'ERR_MISSING_ARGS'})
  const text=base64String(value)
  for(let i=0;i<text.length;i++)if(text.charCodeAt(i)>255)throw invalidBase64()
  return Buffer.from(text,'latin1').toString('base64')
}
export function atob(value){
  if(!arguments.length)throw Object.assign(new TypeError('One argument is required'),{code:'ERR_MISSING_ARGS'})
  let text=base64String(value).replace(/[\t\n\f\r ]/g,'')
  if(text.length%4===0)text=text.replace(/={1,2}$/,'')
  if(text.length%4===1||/[^A-Za-z0-9+/]/.test(text))throw invalidBase64()
  return Buffer.from(text,'base64').toString('latin1')
}
core.buffer.atob=atob;core.buffer.btoa=btoa
