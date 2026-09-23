import {isIP} from 'node:net'
import {promisify} from 'node:util'

let defaultOrder='verbatim'
const invalid=(message)=>Object.assign(new TypeError(message),{code:'ERR_INVALID_ARG_VALUE'})
const order=value=>{if(!['verbatim','ipv4first','ipv6first'].includes(value))throw invalid('Invalid DNS result order');return value}
export const getDefaultResultOrder=()=>defaultOrder
export const setDefaultResultOrder=value=>{defaultOrder=order(value)}
function settings(options){
  if(typeof options==='number')options={family:options}
  options??={}
  if(typeof options!=='object'||Array.isArray(options))throw invalid('Invalid lookup options')
  let family=options.family??0;if(family==='IPv4')family=4;if(family==='IPv6')family=6
  if(![0,4,6].includes(family))throw invalid('Invalid address family')
  if(options.all!==undefined&&typeof options.all!=='boolean')throw invalid('Invalid all option')
  if(options.verbatim!==undefined&&typeof options.verbatim!=='boolean')throw invalid('Invalid verbatim option')
  if(options.hints!==undefined&&options.hints!==0)throw Object.assign(Error('Host address configuration hints are unavailable'),{code:'ERR_UNSUPPORTED_OPERATION'})
  return {family,all:options.all??false,order:order(options.order??(options.verbatim===false?'ipv4first':options.verbatim===true?'verbatim':defaultOrder))}
}
function resolveLocal(hostname,options){
  if(!hostname)return options.all?[]:{address:null,family:options.family===6?6:4}
  const family=isIP(hostname)
  let addresses
  if(family)addresses=[{address:hostname,family}]
  else if(hostname.toLowerCase().replace(/\.$/,'')==='localhost'){
    addresses=[{address:'127.0.0.1',family:4},{address:'::1',family:6}]
    if(options.family)addresses=addresses.filter(entry=>entry.family===options.family)
    if(options.order==='ipv6first')addresses.reverse()
  }else throw Object.assign(Error('External hostname lookup is not permitted: '+hostname),{code:'EACCES',syscall:'getaddrinfo',hostname})
  return options.all?addresses:addresses[0]
}
export function lookup(hostname,options,callback){
  if(typeof options==='function'){callback=options;options={}}
  if(typeof callback!=='function')throw new TypeError('Expected callback')
  if(hostname!==null&&hostname!==undefined&&typeof hostname!=='string')throw new TypeError('Expected hostname string')
  const selected=settings(options)
  queueMicrotask(()=>{
    let result;try{result=resolveLocal(hostname,selected)}catch(error){callback(error);return}
    if(selected.all)callback(null,result);else callback(null,result.address,result.family)
  })
}
const lookupPromise=(hostname,options)=>new Promise((resolve,reject)=>lookup(hostname,options,(error,address,family)=>{if(error)reject(error);else resolve(Array.isArray(address)?address:{address,family})}))
lookup[promisify.custom]=lookupPromise
export const promises={lookup:lookupPromise,getDefaultResultOrder,setDefaultResultOrder}
export default {lookup,promises,getDefaultResultOrder,setDefaultResultOrder}
