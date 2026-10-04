const key=Symbol.for('tanstack-container:filesystem-provider-v1')

// Installed before compiler modules import node:fs. Never retarget open handles.
export function installNativeFilesystemProvider(provider,scope=globalThis){
  if(!provider?.fs||!provider?.vol)throw TypeError('Filesystem provider requires fs and vol')
  if(scope[key])throw Error('Filesystem provider is already installed')
  Object.defineProperty(scope,key,{value:provider,writable:false,configurable:false})
  return provider
}
export function getNativeFilesystemProvider(scope=globalThis){return scope[key]}
