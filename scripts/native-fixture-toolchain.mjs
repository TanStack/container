export function verifyFixtureToolchain(shipped,lock){
  for(const [browserName,installedName] of [['@rolldown/browser','rolldown'],['vite','vite']]){
    const installed=lock.packages?.[`node_modules/${installedName}`]?.version
    if(!installed)continue
    const versions=shipped.toolchain
      ?(typeof shipped.toolchain[installedName]==='string'?[shipped.toolchain[installedName]]:[])
      :[...new Set(shipped.packages.filter(item=>item.name===browserName).map(item=>item.version))]
    if(versions.length!==1||versions[0]!==installed)throw Error(`Fixture ${installedName}@${installed} requires one matching browser toolchain, available ${browserName}: ${versions.join(', ')||'none'}`)
  }
}
