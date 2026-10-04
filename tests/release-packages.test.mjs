import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readReleasePackages,releasePackages} from '../scripts/build-release-packages.mjs'
import {verifyReleasePackageMetadata} from '../scripts/verify-release-packages.mjs'

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'container-release-test-'))
  for(const path of Object.values(releasePackages)){
    mkdirSync(join(root,path,'dist'),{recursive:true})
    const outer=JSON.parse(readFileSync(join(path,'package.json')))
    writeFileSync(join(root,path,'package.json'),JSON.stringify(outer))
    const inner={...outer,private:false,publishConfig:{access:'public'}}
    const bytes=Buffer.from(JSON.stringify(inner))
    writeFileSync(join(root,path,'dist/package.json'),bytes)
    writeFileSync(join(root,path,'dist/package-assets.json'),JSON.stringify({format:1,files:[{path:'package.json',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]}))
  }
  return root
}
test('tracked versions match generated publication bytes',()=>{
  const root=fixture()
  assert.equal(verifyReleasePackageMetadata(root).sdk.version,readReleasePackages().sdk.version)
})
test('version drift and modified package bytes stop release',()=>{
  const root=fixture(),path=join(root,releasePackages.runtime,'package.json')
  const pkg=JSON.parse(readFileSync(path));pkg.version='0.1.0-alpha.99';writeFileSync(path,JSON.stringify(pkg))
  assert.throws(()=>readReleasePackages(root),/versions must stay together/)
  const other=fixture()
  writeFileSync(join(other,releasePackages.sdk,'dist/extra.js'),'unexpected')
  assert.throws(()=>verifyReleasePackageMetadata(other),/inventory differs/)
})
test('Changesets keeps the exact-version SDK/runtime pair fixed',()=>{
  const config=JSON.parse(readFileSync('.changeset/config.json'))
  const manifests=readReleasePackages()
  assert.deepEqual(config.fixed,[[manifests.sdk.name,manifests.runtime.name]])
  assert.equal(config.baseBranch,'main')
  assert.equal(config.changelog[1].repo,'TanStack/container')
  const pkg=JSON.parse(readFileSync('package.json'))
  assert.match(pkg.scripts['changeset:publish'],/release:prepare.*changeset publish --tag alpha/)
})
test('release uses trusted publishing and reserves the first publish for the maintainer',()=>{
  const workflow=readFileSync('.github/workflows/release.yml','utf8')
  assert.match(workflow,/id-token: write/)
  assert.match(workflow,/vars.RELEASE_ENABLED == 'true'/)
  assert.match(workflow,/github.event_name == 'workflow_dispatch'/)
  assert.match(workflow,/cancel-in-progress: false/)
  assert.doesNotMatch(workflow,/NPM_TOKEN|NODE_AUTH_TOKEN|npm publish/)
  const refs=[...workflow.matchAll(/TanStack\/config\/\.github\/setup@([^\s]+)/g)].map(match=>match[1])
  assert.deepEqual(refs,['190f659075ff0845850e330883eb26d7ffd0671f','190f659075ff0845850e330883eb26d7ffd0671f'])
  assert.equal((workflow.match(/npm install --global npm@11\.12\.1\s+npm ci --ignore-scripts --no-audit --no-fund\s+npm ci --prefix tests\/fixtures\/native-runtime-832/g)??[]).length,2)
  assert.equal((workflow.match(/npm ci --prefix tests\/fixtures\/native-runtime-832/g)??[]).length,2)
  assert.equal((workflow.match(/playwright install --with-deps chromium firefox webkit/g)??[]).length,2)
  assert.doesNotMatch(workflow,/npm ci --prefix (?:fixtures\/workloads|tests\/fixtures\/rolldown-native-probe)/)
  const pkg=JSON.parse(readFileSync('package.json'))
  assert.ok(pkg.scripts['test:release'].includes('tests/native-runtime-build-plan.test.mjs'))
  assert.ok(pkg.scripts['test:release'].includes('tests/native-example-sources.test.mjs'))
  assert.ok(pkg.scripts['test:release'].includes('tests/native-sdk-entry.test.mjs'))
  assert.ok(pkg.scripts['test:release'].includes('tests/sdk-browser-assets.test.mjs'))
  const verifier=readFileSync('scripts/verify-release-packages.mjs','utf8')
  assert.match(verifier,/const nativeAcceptance=runNativeReleaseAcceptance\(\{root,/)
  assert.match(verifier,/sdk:join\(adoption.consumer,'node_modules\/@tanstack\/browser-sandbox-experimental'\)/)
  assert.match(verifier,/deployment:adoption.output.directory/)
  assert.match(verifier,/JSON.stringify\(\{version:record.version,source,adoption,nativeAcceptance,tarballs/)
  assert.doesNotMatch(verifier,/tests\/sdk-frameworks\/|tests\/sdk\/framework-example|SDK_NATIVE_COMPILER/)
})

test('real Changesets advances both alpha versions and the exact internal dependency',()=>{
  const root=fixture()
  mkdirSync(join(root,'.changeset'))
  const config=JSON.parse(readFileSync('.changeset/config.json'))
  // Version calculation stays real. Changelog API access is not part of this
  // offline test; CI uses the configured GitHub changelog with GITHUB_TOKEN.
  config.changelog=false
  writeFileSync(join(root,'.changeset/config.json'),JSON.stringify(config))
  writeFileSync(join(root,'.changeset/pre.json'),readFileSync('.changeset/pre.json'))
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'release-fixture',private:true,workspaces:['packages/*']}))
  const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'})
  git(['init','-b','main'])
  git(['add','.'])
  git(['-c','user.name=Release Test','-c','user.email=release-test@example.invalid','commit','-m','fixture'])
  writeFileSync(join(root,'.changeset/runtime-fix.md'),'---\n"@tanstack/browser-sandbox-runtime-experimental": patch\n---\n\nFix runtime behavior.\n')
  const cli=resolve('node_modules/@changesets/cli/bin.js')
  execFileSync(process.execPath,[cli,'status'],{cwd:root,stdio:'pipe'})
  execFileSync(process.execPath,[cli,'version'],{cwd:root,stdio:'pipe'})
  const versions=readReleasePackages(root)
  assert.equal(versions.sdk.version,'0.1.0-alpha.1')
  assert.equal(versions.runtime.version,'0.1.0-alpha.1')
  assert.equal(versions.sdk.dependencies[versions.runtime.name],'0.1.0-alpha.1')
})
