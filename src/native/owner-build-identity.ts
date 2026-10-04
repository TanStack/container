/** A deployment-configured identity, not independently verified attestation. */
export function nativeOwnerBuildId(value:unknown):string|undefined{
  if(value===undefined)return undefined
  if(typeof value!=='string'||value.length<1||value.length>256||!/^[\x21-\x7e]+$/.test(value))
    throw new TypeError('Invalid native owner build identity')
  return value
}
export function verifyNativeOwnerBuildId(actual:unknown,expected?:string):string|undefined{
  const value=nativeOwnerBuildId(actual)
  if(expected!==undefined&&value!==nativeOwnerBuildId(expected))
    throw Error('Native owner build identity mismatch')
  return value
}
