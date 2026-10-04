import type {ProjectInstallResult} from '../npm/project'
import type {RuntimeLock} from '../npm/types'

/** Report only a successfully committed install, preserving skipped packages and scripts. */
export function nativeInstallResult(lock:RuntimeLock,planned?:ProjectInstallResult):ProjectInstallResult {
  const installed=new Set<string>()
  for(const pkg of lock.packages){
    installed.add(pkg.installPath)
    for(const bundled of pkg.bundledPackages??[])installed.add(bundled.installPath)
  }
  return {
    installed:installed.size,
    skippedPlatformPackages:[...(planned?.skippedPlatformPackages??[])],
    ignoredScripts:[...(planned?.ignoredScripts??[])],
    ...(planned?.packageAliases?{packageAliases:planned.packageAliases.map(alias=>({...alias}))}:{}),
  }
}
