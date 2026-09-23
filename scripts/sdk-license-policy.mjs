export const SDK_SUPPORTED_LICENSES=Object.freeze([
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MPL-2.0',
])

export function isSupportedSDKLicense(value){
  return typeof value==='string'&&SDK_SUPPORTED_LICENSES.includes(value)
}

const alphaVersion=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function isAlphaSDKVersion(value){
  if(typeof value!=='string')return false
  const match=alphaVersion.exec(value)
  if(!match)return false
  const prerelease=match[4].split('.')
  return prerelease[0]==='alpha'&&prerelease.every(identifier=>!/^\d+$/.test(identifier)||identifier==='0'||!identifier.startsWith('0'))
}
