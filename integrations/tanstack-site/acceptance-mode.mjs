import {isIP} from 'node:net'

const sha256Pattern=/^[a-f0-9]{64}$/i
const sriPattern=/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/

const privateIPv4=hostname=>{
  const parts=hostname.split('.').map(Number)
  return parts[0]===10||parts[0]===127||parts[0]===0||(parts[0]===169&&parts[1]===254)||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168)
}

export function isPrivateHostname(hostname){
  const host=hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'')
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local'))return true
  if(isIP(host)===4)return privateIPv4(host)
  if(isIP(host)===6)return host==='::1'||host==='::'||host.startsWith('fc')||host.startsWith('fd')||/^fe[89ab]/.test(host)
  return false
}

export function publicHTTPSURL(value,label='URL'){
  let url
  try { url=new URL(value) } catch { throw Error(`${label} must be an absolute URL`) }
  if(url.protocol!=='https:')throw Error(`${label} must use HTTPS`)
  if(url.username||url.password)throw Error(`${label} must not contain credentials`)
  if(isPrivateHostname(url.hostname))throw Error(`${label} must not target a loopback, private, or local host`)
  return url
}

export function acceptanceConfig(env=process.env){
  const mode=env.TANSTACK_ACCEPTANCE_MODE??'local'
  if(mode!=='local'&&mode!=='deployed')throw Error("TANSTACK_ACCEPTANCE_MODE must be 'local' or 'deployed'")
  if(mode==='local')return {mode,ownerUrl:new URL(env.TANSTACK_OWNER_URL??'http://127.0.0.1:4198/start/latest/docs/framework/react/examples/start-counter'),previewOrigin:env.TANSTACK_PREVIEW_ORIGIN??'http://127.0.0.1:4199'}
  const required=['TANSTACK_OWNER_URL','SDK_EXPECTED_PACKAGE_NAME','SDK_EXPECTED_PACKAGE_VERSION','SDK_EXPECTED_PACKAGE_INTEGRITY','SDK_MANIFEST_SHA256','SDK_TARBALL_SHA256']
  for(const name of required)if(!env[name])throw Error(`${name} is required in deployed acceptance mode`)
  if(!sha256Pattern.test(env.SDK_MANIFEST_SHA256)||!sha256Pattern.test(env.SDK_TARBALL_SHA256))throw Error('SDK manifest and tarball SHA256 values must be 64 hexadecimal characters')
  if(!sriPattern.test(env.SDK_EXPECTED_PACKAGE_INTEGRITY))throw Error('SDK_EXPECTED_PACKAGE_INTEGRITY must be an SRI sha256, sha384, or sha512 value')
  return {mode,ownerUrl:publicHTTPSURL(env.TANSTACK_OWNER_URL,'TANSTACK_OWNER_URL'),expectedPackage:{name:env.SDK_EXPECTED_PACKAGE_NAME,version:env.SDK_EXPECTED_PACKAGE_VERSION,integrity:env.SDK_EXPECTED_PACKAGE_INTEGRITY},manifestSHA256:env.SDK_MANIFEST_SHA256.toLowerCase(),tarballSHA256:env.SDK_TARBALL_SHA256.toLowerCase()}
}

export function verifyDeployedIdentity(identity,config){
  if(!identity||typeof identity!=='object')throw Error('TanStack.com did not expose an SDK package identity')
  const actual={name:identity.packageName,version:identity.packageVersion,integrity:identity.packageIntegrity}
  for(const key of ['name','version','integrity'])if(actual[key]!==config.expectedPackage[key])throw Error(`Published SDK ${key} mismatch: expected ${config.expectedPackage[key]}, received ${actual[key]??'missing'}`)
  const resolved=identity.packageResolved
  if(typeof resolved!=='string'||/^(?:file|link|workspace):/i.test(resolved))throw Error('Published SDK resolution must not use a file, link, or workspace package')
  publicHTTPSURL(resolved,'Published SDK resolution')
  if(identity.sdkManifestSHA256?.toLowerCase()!==config.manifestSHA256)throw Error(`TanStack.com selected SDK manifest ${identity.sdkManifestSHA256??'missing'}, expected ${config.manifestSHA256}`)
  if(identity.sdkTarballSHA256?.toLowerCase()!==config.tarballSHA256)throw Error(`TanStack.com selected SDK tarball ${identity.sdkTarballSHA256??'missing'}, expected ${config.tarballSHA256}`)
  return {actual,resolved,manifestSHA256:config.manifestSHA256,tarballSHA256:config.tarballSHA256}
}

export function isolationHeaders(headers){
  const names=['cross-origin-opener-policy','cross-origin-embedder-policy','cross-origin-resource-policy','content-security-policy','permissions-policy']
  return Object.fromEntries(names.map(name=>[name,headers[name]??null]))
}
