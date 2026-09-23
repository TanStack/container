/** Runtime code is trusted host configuration, never a guest filesystem path. */
export function resolveRuntimeAssetBase(value:unknown,locationURL=globalThis.location.href):string{
  if(value!==undefined&&typeof value!=='string')throw new TypeError('Expected an asset base URL string')
  const location=new URL(locationURL)
  const base=new URL(value===undefined?'/':value as string,location)
  if(!['http:','https:'].includes(base.protocol)||base.origin!==location.origin||base.username||base.password||base.search||base.hash||!base.pathname.endsWith('/'))
    throw new TypeError('Runtime assets require a same-origin HTTP directory URL without credentials, query or fragment')
  return base.href
}

export function runtimeAssetURL(path:string,base?:string):URL{
  return new URL(path,base??resolveRuntimeAssetBase(undefined))
}
