export async function callback(method,args){
  await Promise.resolve()
  if(method==='resolveId'&&args[0]==='virtual:answer')return {id:'\0virtual:answer'}
  if(method==='load'&&args[0]==='\0virtual:answer')return {code:'export default 2'}
  if(method==='transform'&&args[0].endsWith('/value.js'))return {code:args[1].replace(/default (\d+)/,(_match,value)=>'default '+(Number(value)+1))}
  return null
}
