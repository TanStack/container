/** Extra exact HTTPS origins trusted by the sandbox host for locked package archives. */
export interface PackageDownloadPolicy {
  additionalOrigins?:readonly string[]
}

/** Capture caller configuration before asynchronous work or guest messages can change it. */
export function normalizePackageDownloadPolicy(policy?:PackageDownloadPolicy):PackageDownloadPolicy {
  if(policy===undefined)return Object.freeze({additionalOrigins:Object.freeze([])})
  if(!policy||typeof policy!=='object'||Array.isArray(policy))throw TypeError('Package download policy must be an object')
  if(Object.keys(policy).some(key=>key!=='additionalOrigins'))throw TypeError('Unknown package download policy option')
  const origins=policy.additionalOrigins===undefined?[]:policy.additionalOrigins
  if(!Array.isArray(origins)||origins.length>32)throw TypeError('Package download policy requires at most 32 exact HTTPS origins')
  for(const origin of origins){
    if(typeof origin!=='string')throw TypeError('Package download origin must be an exact HTTPS origin')
    const url=new URL(origin)
    if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.search||url.hash)
      throw TypeError('Package download origin must be an exact HTTPS origin')
  }
  return Object.freeze({additionalOrigins:Object.freeze([...new Set(origins)].sort())})
}

export function packageDownloadURL(resolved:string,policy?:PackageDownloadPolicy):URL {
  const configured=normalizePackageDownloadPolicy(policy)
  const url=new URL(resolved)
  if(url.protocol!=='https:'||url.username||url.password||url.hash)
    throw Error('Package archive URL requires HTTPS without credentials or a fragment')
  if(url.origin!=='https://registry.npmjs.org'&&!configured.additionalOrigins!.includes(url.origin))
    throw Error('Package downloads are restricted to https://registry.npmjs.org or host-configured origins')
  return url
}
