/** Native deployment files may only contain the compiler catalog and shell. */
export function assertNativeSDKRuntimePaths(paths){
  for(const path of paths){
    if(typeof path!=='string'||path.includes('\\')||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..'))
      throw Error('Invalid native runtime package path: '+path)
    if(path==='kernel-host.js'||path==='kernel-host.html')throw Error('Native SDK includes a legacy kernel host: '+path)
    if(!path.startsWith('runtime/'))continue
    if(path.startsWith('runtime/native/')||path.startsWith('runtime/mvdan-shell/')||
      path==='runtime/workers/mvdan-shell.js'||/^runtime\/workers\/runtime-assets-[A-Za-z0-9_-]+\.js$/.test(path))continue
    throw Error('Native SDK includes an unsupported runtime asset: '+path)
  }
}
