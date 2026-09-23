import readline from 'node:readline'
import {callback} from './plugin.mjs'
const input=readline.createInterface({input:process.stdin})
console.log('GUEST_READY')
for await(const line of input){
  const message=JSON.parse(line)
  try{console.log(JSON.stringify({id:message.id,value:await callback(message.method,message.args)}))}
  catch(error){console.log(JSON.stringify({id:message.id,error:String(error)}))}
}
