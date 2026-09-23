import {WorkspaceFiles,workspacePath} from './files'
import {URL as WorkspaceURL} from 'whatwg-url'

// This is a virtual origin, never a destination for browser fetch.
export const workspaceAssetOrigin='https://workspace.invalid'
export function createWorkspaceAssetReader(files:WorkspaceFiles){
  let requests=0,bytesRead=0
  return (input:string,method:string)=>{
    if(++requests>128)throw Object.assign(Error('Workspace asset request quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})
    if(input.length>16384)throw new TypeError('Workspace asset URL is too long')
    // Some browser URL implementations discard remote file authorities.
    // Permission checks must use a parser that preserves that information.
    const url=new WorkspaceURL(input)
    if(url.username||url.password||!((url.protocol==='https:'&&url.origin===workspaceAssetOrigin)||(url.protocol==='file:'&&!url.host)))
      throw new TypeError('Only workspace asset URLs are allowed')
    if(method!=='GET'&&method!=='HEAD')throw new TypeError('Workspace assets only support GET and HEAD')
    // Decode once. The filesystem resolves all paths and symlinks within its own
    // root, with no access to the host machine's filesystem.
    const path=workspacePath(decodeURIComponent(url.pathname))
    url.hash=''
    let stat
    try{stat=files.statSync(path)}catch(error){
      if(!(error instanceof Error)||!error.message.startsWith('ENOENT:'))throw error
    }
    const found=stat?.kind==='file',size=found?stat!.size:0
    if(method==='GET'&&(size>8*1024*1024||bytesRead+size>32*1024*1024))
      throw Object.assign(Error('Workspace asset byte quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})
    const types:Record<string,string>={wasm:'application/wasm',json:'application/json',js:'text/javascript',mjs:'text/javascript',css:'text/css',html:'text/html',txt:'text/plain',svg:'image/svg+xml',png:'image/png'}
    const extension=path.split('.').pop()!
    const metadata={url:url.href,status:found?200:404,statusText:found?'OK':'Not Found',
      headers:{'content-type':Object.hasOwn(types,extension)?types[extension]:'application/octet-stream','content-length':String(size)}}
    if(method==='HEAD')return {metadata,bytes:null}
    bytesRead+=size
    return {metadata,bytes:found?files.readFileSync(path):new Uint8Array()}
  }
}
