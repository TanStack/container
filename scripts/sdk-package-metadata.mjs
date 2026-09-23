import assert from 'node:assert/strict'
import {lstatSync} from 'node:fs'
import {resolve} from 'node:path'
import {isAlphaSDKVersion,isSupportedSDKLicense,SDK_SUPPORTED_LICENSES} from './sdk-license-policy.mjs'

export const SDK_PACKAGE_DESCRIPTION='A browser-powered JavaScript and TypeScript development sandbox with virtual files, processes, previews and resumable workspaces.'
export const SDK_PACKAGE_KEYWORDS=['browser','sandbox','javascript','typescript','vite','tanstack-start','webassembly']

const releaseURLFields={
  SDK_RELEASE_REPOSITORY_URL:'repository',
  SDK_RELEASE_HOMEPAGE_URL:'homepage',
  SDK_RELEASE_BUGS_URL:'bugs',
}

function readPublicURL(environment,name){
  const value=environment[name]?.trim()
  if(value===undefined||value==='')return undefined
  let url
  try{url=new URL(value)}catch{throw Error(`${name} must be an absolute HTTPS URL`)}
  assert.equal(url.protocol,'https:',`${name} must be an absolute HTTPS URL`)
  assert.equal(url.username,'',`${name} must not contain credentials`)
  assert.equal(url.password,'',`${name} must not contain credentials`)
  return url.href
}

export function resolveSDKPackageMetadata({environment=process.env,projectRoot=process.cwd()}={}){
  const mode=environment.SDK_RELEASE
  assert.ok(mode===undefined||mode==='0'||mode==='1','SDK_RELEASE must be 0 or 1')
  const release=mode==='1'
  const version=environment.SDK_RELEASE_VERSION?.trim()
  const license=environment.SDK_RELEASE_LICENSE?.trim()
  const publicURLs=Object.fromEntries(Object.entries(releaseURLFields).map(([name,field])=>[field,readPublicURL(environment,name)]))
  const common={description:SDK_PACKAGE_DESCRIPTION,keywords:SDK_PACKAGE_KEYWORDS}
  if(!release){
    assert.equal(version,undefined,'SDK_RELEASE_VERSION requires SDK_RELEASE=1')
    assert.equal(license,undefined,'SDK_RELEASE_LICENSE requires SDK_RELEASE=1')
    for(const [name,field] of Object.entries(releaseURLFields))assert.equal(publicURLs[field],undefined,`${name} requires SDK_RELEASE=1`)
    const licensePath=resolve(projectRoot,'LICENSE'),stat=lstatSync(licensePath)
    assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Project LICENSE must be a regular file')
    return {packageFields:{...common,version:'0.0.0',private:true,license:'MIT'},licensePath,release:false}
  }
  assert.ok(isAlphaSDKVersion(version),'SDK_RELEASE_VERSION must be an explicit alpha semantic version')
  assert.ok(isSupportedSDKLicense(license),`SDK_RELEASE_LICENSE must be one supported SPDX identifier: ${SDK_SUPPORTED_LICENSES.join(', ')}`)
  const licensePath=resolve(projectRoot,'LICENSE'),stat=lstatSync(licensePath)
  assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Release LICENSE must be a regular file')
  assert.ok(publicURLs.repository,'SDK_RELEASE_REPOSITORY_URL is required for an open-source release')
  return {
    packageFields:{
      ...common,version,license,publishConfig:{access:'public'},
      repository:{type:'git',url:publicURLs.repository},
      ...(publicURLs.homepage?{homepage:publicURLs.homepage}:{}),
      ...(publicURLs.bugs?{bugs:{url:publicURLs.bugs}}:{}),
    },
    licensePath,
    release:true,
  }
}
