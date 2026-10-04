export function mountNativeWorkspaceFiles(files:Record<string,string|Uint8Array>,root='/app'){
  if(!/^\/[A-Za-z0-9._-]+$/.test(root)||root==='/.'||root==='/..')throw Error('workspaceRoot must be a single absolute directory name')
  const mounted:Record<string,string|Uint8Array>={}
  for(const [path,value] of Object.entries(files)){
    if(path!==root&&!path.startsWith(root+'/'))throw Error(`Path must be inside ${root}: ${path}`)
    if(path.split('/').some((part,index)=>index>0&&(!part||part==='.'||part==='..'))||path.includes('\\')||path.includes('\0'))throw Error(`Invalid workspace path: ${path}`)
    const target='/app'+path.slice(root.length)
    if(Object.hasOwn(mounted,target))throw Error(`Duplicate workspace file: ${path}`)
    mounted[target]=value
  }
  return mounted
}
