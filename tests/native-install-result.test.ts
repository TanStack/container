import {expect,it} from 'vitest'
import {nativeInstallResult} from '../src/native/install-result'
it('counts archive and bundled package identities and preserves install decisions',()=>{
  const planned={installed:0,skippedPlatformPackages:['/node_modules/native-only'],ignoredScripts:['/','/node_modules/a'],packageAliases:[{installPath:'/node_modules/alias',name:'a',version:'1'}]}
  const result=nativeInstallResult({version:1,packages:[{installPath:'/node_modules/a',name:'a',version:'1',resolved:'https://registry.npmjs.org/a',integrity:'x',bundledPackages:[{installPath:'/node_modules/a/node_modules/b',name:'b',version:'1'}]}]},planned)
  expect(result).toEqual({...planned,installed:2})
  result.ignoredScripts.push('changed');result.packageAliases![0].name='changed'
  expect(planned.ignoredScripts).toHaveLength(2);expect(planned.packageAliases[0].name).toBe('a')
})
