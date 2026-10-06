import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {lstatSync} from 'node:fs'
import {isAbsolute,join} from 'node:path'

export const mvdanShellGoBuild = {
  trimpath: true,
  buildvcs: false,
  ldflags: ['-s', '-w'],
}

export const mvdanShellModule=Object.freeze({path:'mvdan.cc/sh/v3',version:'v3.14.1'})

export function mvdanShellModuleLicense(go,source,env,run=execFileSync){
  const options={cwd:source,env,encoding:'utf8'}
  const info=JSON.parse(run(go,['list','-m','-mod=readonly','-json',mvdanShellModule.path],options))
  assert.equal(info.Path,mvdanShellModule.path,'Shell module identity changed')
  assert.equal(info.Version,mvdanShellModule.version,'Shell module version changed')
  assert.equal(info.Replace,undefined,'Shell module replacements are not release inputs')
  assert.ok(typeof info.Dir==='string'&&isAbsolute(info.Dir),'Shell module directory must be absolute')
  // Ask the same Go tool and environment used by the build. GOMODCACHE can
  // override GOPATH, and the notice must come from the module actually built.
  run(go,['mod','verify'],options)
  const license=join(info.Dir,'LICENSE'),stat=lstatSync(license)
  assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Shell module notice must be a regular file')
  return license
}

export function mvdanShellBuildArguments(output) {
  return ['build', '-trimpath', '-buildvcs=false', '-mod=readonly',
    '-ldflags=' + mvdanShellGoBuild.ldflags.join(' '), '-o', output, '.']
}
