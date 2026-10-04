function exactOrigin(value,name){
  if(typeof value!=='string')throw TypeError(`${name} must be an origin URL`)
  const url=new URL(value)
  const local=url.protocol==='http:'&&(['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.hostname.endsWith('.localhost'))
  if(url.origin!==value||url.username||url.password||url.search||url.hash||(!local&&url.protocol!=='https:'))
    throw Error(`${name} must be an exact HTTPS origin, or an HTTP loopback origin for development`)
  return value
}

function sameOriginPath(value,name){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.includes('\\'))
    throw TypeError(`${name} must be an absolute same-origin path`)
  const url=new URL(value,'https://owner.invalid')
  if(url.origin!=='https://owner.invalid'||url.pathname!==value||url.search||url.hash)
    throw TypeError(`${name} must be an absolute same-origin path`)
  return value
}

/** Static owner files for a dedicated, credential-free browser sandbox origin. */
export function createNativeOwnerHostAssets({parentOrigin,previewOrigin,previewHostSuffix,buildId,runtimeCandidates,sdkPath='/sdk/index.js',workerPath='/runtime/native/engine.js',assetBaseURL='/runtime/'}){
  if(buildId!==undefined&&(typeof buildId!=='string'||!buildId.length||buildId.length>256||!/^[\x21-\x7e]+$/.test(buildId)))
    throw TypeError('buildId must be a nonempty printable ASCII string of at most 256 characters')
  parentOrigin=exactOrigin(parentOrigin,'parentOrigin')
  previewOrigin=exactOrigin(previewOrigin,'previewOrigin')
  if(previewHostSuffix!==undefined&&
    (typeof previewHostSuffix!=='string'||!/^\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(previewHostSuffix)))
    throw Error('previewHostSuffix must be a hostname suffix')
  if(parentOrigin===previewOrigin)throw Error('Parent and preview origins must differ')
  sdkPath=sameOriginPath(sdkPath,'sdkPath')
  workerPath=sameOriginPath(workerPath,'workerPath')
  assetBaseURL=sameOriginPath(assetBaseURL,'assetBaseURL')
  if(!assetBaseURL.endsWith('/'))throw Error('assetBaseURL must be a directory path')
  if(runtimeCandidates!==undefined){
    if(!Array.isArray(runtimeCandidates)||!runtimeCandidates.length)throw TypeError('runtimeCandidates must be a nonempty array')
    runtimeCandidates=runtimeCandidates.map(candidate=>{
      const workerURL=sameOriginPath(candidate.workerURL,'runtime candidate workerURL')
      const toolchain={vite:candidate.toolchain?.vite,rolldown:candidate.toolchain?.rolldown}
      if(Object.values(toolchain).some(version=>typeof version!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)))throw TypeError('Runtime candidates require exact compiler versions')
      return {workerURL,toolchain}
    })
  }
  const html='<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/__sandbox/owner.js"></script></body></html>\n'
  const script=`import { installNativeOwnerHost } from ${JSON.stringify(sdkPath)};\n`+
    `const parentOrigin = ${JSON.stringify(parentOrigin)};\n`+
    `const previewOrigin = ${JSON.stringify(previewOrigin)};\n`+
    `if (location.origin === parentOrigin || location.origin === previewOrigin) throw Error('Owner origin must be separate');\n`+
    `installNativeOwnerHost({ allowedParentOrigin: parentOrigin, previewOrigin, previewHostSuffix: ${JSON.stringify(previewHostSuffix)}, buildId: ${JSON.stringify(buildId)}, workerURL: ${JSON.stringify(workerPath)}, assetBaseURL: ${JSON.stringify(assetBaseURL)}, runtimeCandidates: ${JSON.stringify(runtimeCandidates)} });\n`+
    `parent.postMessage('native-owner-ready', parentOrigin);\n`
  return {
    files:{'/owner.html':html,'/__sandbox/owner.js':script},
    headers:{
      '/owner.html':{'Content-Type':'text/html','Cache-Control':'no-store','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'cross-origin','X-Content-Type-Options':'nosniff'},
      '/__sandbox/owner.js':{'Content-Type':'text/javascript','Cache-Control':'no-store','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'cross-origin','X-Content-Type-Options':'nosniff'},
    },
  }
}
