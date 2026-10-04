/** Preserve the original failure, adding only virtual socket metadata. */
export function captureNativeNetworkFailure(error:unknown,snapshot:()=>unknown){
  if((error as {code?:string}|null)?.code==='ECONNRESET')
    console.error('NATIVE_NETWORK_FAILURE',JSON.stringify({error:String(error),handles:snapshot()}))
}

export function reportNativeNetworkFailure(error:unknown,snapshot:()=>unknown):never{
  try{
    captureNativeNetworkFailure(error,snapshot)
  }finally{throw error}
}
