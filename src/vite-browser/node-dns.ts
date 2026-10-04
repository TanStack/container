import {isIP} from '../sandbox/guest-net.js'

type LookupOptions={all?:boolean;family?:number;verbatim?:boolean;order?:string}
type LookupResult={address:string;family:4|6}

function resolveLocal(hostname:string,options:LookupOptions={}):LookupResult|LookupResult[]{
  let address:string,family:4|6
  if(hostname==='localhost'){
    family=options.family===6?6:4
    address=family===6?'::1':'127.0.0.1'
  }else{
    const detected=isIP(hostname)
    if(!detected||options.family&&options.family!==detected){
      throw Object.assign(new Error(`DNS lookup is unavailable for ${hostname}`),{code:'ENOTFOUND',hostname})
    }
    family=detected as 4|6
    address=hostname
  }
  const result={address,family}
  return options.all?[result]:result
}

export const promises={
  lookup:async(hostname:string,options:LookupOptions={})=>resolveLocal(hostname,options),
  getDefaultResultOrder:()=>'verbatim' as const,
}

export function lookup(hostname:string,options:LookupOptions|((error:Error|null,address?:string,family?:number)=>void),callback?:(error:Error|null,address?:string,family?:number)=>void):void{
  const selected=typeof options==='function'?{}:options
  const done=typeof options==='function'?options:callback
  if(!done)throw Object.assign(new TypeError('DNS lookup requires a callback'),{code:'ERR_INVALID_ARG_TYPE'})
  queueMicrotask(()=>{
    try{
      const result=resolveLocal(hostname,selected) as LookupResult
      done(null,result.address,result.family)
    }catch(error){done(error as Error)}
  })
}

export default {lookup,promises}
