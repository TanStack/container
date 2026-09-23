import requestPolicy from './request-policy.json'

export interface PreviewTimeoutOptions {
  requestTimeoutMs?:number
  startupTimeoutMs?:number
}

function timeout(value:unknown,fallback:number,name:string){
  const resolved=value??fallback
  if(!Number.isSafeInteger(resolved)||Number(resolved)<10||Number(resolved)>requestPolicy.maxRequestTimeoutMs)
    throw new RangeError(`${name} must be an integer from 10 to ${requestPolicy.maxRequestTimeoutMs}`)
  return Number(resolved)
}

export const previewRequestTimeout=(value?:number)=>timeout(value,requestPolicy.defaultRequestTimeoutMs,'requestTimeoutMs')
export const previewStartupTimeout=(value?:number)=>timeout(value,requestPolicy.defaultStartupTimeoutMs,'startupTimeoutMs')

