import {createHash} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'

export const SDK_COMPATIBILITY_POLICY={
  format:1,
  stability:'experimental',
  promise:'Compatibility is checked between explicit SDK build artifacts. This is not a stable-package or semantic-versioning promise.',
  apiVersion:{type:'positive integer',monotonic:true,bump:'exactly when a candidate removes or changes a declared API, removes or changes a package export, removes a runtime asset URL, changes the hosting contract, or changes the build profile'},
  declarations:{additive:['new exports','new entrypoints'],breaking:['removed exports','changed exported declarations','removed entrypoints']},
  packageExports:{additive:['new subpath exports'],breaking:['removed subpath exports','changed export conditions or targets']},
  runtimeAssets:{additive:['new runtime asset URLs'],compatible:['new bytes at an existing URL when its public role is unchanged'],breaking:['removed runtime asset URLs']},
  hosting:{breaking:['any preview-host/hosting.json contract change']},
  buildProfile:{breaking:['any buildProfile change']},
  versionRule:{additive:'apiVersion must stay unchanged',breaking:'apiVersion must increase',mixed:'apiVersion must increase'},
}
export function writeSDKCompatibilityPolicy(root){
  const path='compatibility-policy.json',bytes=Buffer.from(JSON.stringify(SDK_COMPATIBILITY_POLICY,null,2)+'\n')
  writeFileSync(join(root,path),bytes)
  return {path,format:1,stability:'experimental',sha256:createHash('sha256').update(bytes).digest('hex')}
}
