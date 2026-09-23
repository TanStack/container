import readline from 'node:readline'
import {resolveSubpathImports} from './resolve-callback.mjs'
const input=readline.createInterface({input:process.stdin})
console.log('GUEST_READY')
for await(const line of input){
  const request=JSON.parse(line)
  try{
    let value
    if(request.method==='resolveSubpathImports')value=resolveSubpathImports(...request.args)
    else if(request.method!=='onWarn')throw Error('Unsupported guest callback')
    // Keep undefined distinct from null across the line protocol.
    console.log(JSON.stringify({id:request.id,kind:value===undefined?'undefined':'value',value}))
  }catch(error){console.log(JSON.stringify({id:request.id,error:String(error)}))}
}
