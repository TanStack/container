import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {resolveSDKPackageMetadata,SDK_PACKAGE_DESCRIPTION,SDK_PACKAGE_KEYWORDS} from '../scripts/sdk-package-metadata.mjs'

const project=()=>mkdtempSync(join(tmpdir(),'sdk-package-metadata-'))

test('ordinary SDK builds stay unmistakably private',()=>{
  const root=project(),licensePath=join(root,'LICENSE')
  writeFileSync(licensePath,'MIT License\n')
  assert.deepEqual(resolveSDKPackageMetadata({environment:{},projectRoot:root}),{
    packageFields:{description:SDK_PACKAGE_DESCRIPTION,keywords:SDK_PACKAGE_KEYWORDS,version:'0.0.0',private:true,license:'MIT'},licensePath,release:false,
  })
})

test('private development builds preserve the project license without enabling publication',()=>{
  const root=project()
  assert.throws(()=>resolveSDKPackageMetadata({environment:{},projectRoot:root}),/LICENSE/)
  writeFileSync(join(root,'license-target'),'MIT License\n')
  symlinkSync(join(root,'license-target'),join(root,'LICENSE'))
  assert.throws(()=>resolveSDKPackageMetadata({environment:{},projectRoot:root}),/regular file/)
})

test('release metadata is explicit and carries a real project license',()=>{
  const root=project(),licensePath=join(root,'LICENSE')
  writeFileSync(licensePath,'selected license text\n')
  assert.deepEqual(resolveSDKPackageMetadata({environment:{SDK_RELEASE:'1',SDK_RELEASE_VERSION:'0.1.0-alpha.1',SDK_RELEASE_LICENSE:'MIT',SDK_RELEASE_REPOSITORY_URL:'https://example.com/owner/project.git'},projectRoot:root}),{
    packageFields:{description:SDK_PACKAGE_DESCRIPTION,keywords:SDK_PACKAGE_KEYWORDS,version:'0.1.0-alpha.1',license:'MIT',publishConfig:{access:'public'},repository:{type:'git',url:'https://example.com/owner/project.git'}},licensePath,release:true,
  })
})

test('public releases require an explicit source repository, while other URLs remain optional',()=>{
  const root=project()
  writeFileSync(join(root,'LICENSE'),'selected license text\n')
  for(const repository of [undefined,'','  '])assert.throws(()=>resolveSDKPackageMetadata({
    environment:{SDK_RELEASE:'1',SDK_RELEASE_VERSION:'0.1.0-alpha.1',SDK_RELEASE_LICENSE:'MIT',SDK_RELEASE_REPOSITORY_URL:repository},projectRoot:root,
  }),/SDK_RELEASE_REPOSITORY_URL is required/)
})

test('release metadata accepts only explicit public URLs without inventing defaults',()=>{
  const root=project(),licensePath=join(root,'LICENSE')
  writeFileSync(licensePath,'selected license text\n')
  const environment={
    SDK_RELEASE:'1',SDK_RELEASE_VERSION:'0.1.0-alpha.1',SDK_RELEASE_LICENSE:'MIT',
    SDK_RELEASE_REPOSITORY_URL:'https://example.com/owner/project.git',
    SDK_RELEASE_HOMEPAGE_URL:'https://example.com/project',
    SDK_RELEASE_BUGS_URL:'https://example.com/owner/project/issues',
  }
  assert.deepEqual(resolveSDKPackageMetadata({environment,projectRoot:root}).packageFields,{
    description:SDK_PACKAGE_DESCRIPTION,keywords:SDK_PACKAGE_KEYWORDS,
    version:'0.1.0-alpha.1',license:'MIT',publishConfig:{access:'public'},
    repository:{type:'git',url:'https://example.com/owner/project.git'},
    homepage:'https://example.com/project',bugs:{url:'https://example.com/owner/project/issues'},
  })
  assert.throws(()=>resolveSDKPackageMetadata({environment:{SDK_RELEASE_REPOSITORY_URL:'https://example.com/project'},projectRoot:root}),/requires SDK_RELEASE=1/)
  assert.throws(()=>resolveSDKPackageMetadata({environment:{...environment,SDK_RELEASE_REPOSITORY_URL:'git@example.com:owner/project.git'},projectRoot:root}),/absolute HTTPS URL/)
  assert.throws(()=>resolveSDKPackageMetadata({environment:{...environment,SDK_RELEASE_HOMEPAGE_URL:'http:\/\/example.com/project'},projectRoot:root}),/absolute HTTPS URL/)
  assert.throws(()=>resolveSDKPackageMetadata({environment:{...environment,SDK_RELEASE_BUGS_URL:'https:\/\/user:secret@example.com/issues'},projectRoot:root}),/must not contain credentials/)
})

test('release mode rejects implicit, malformed, or unlicensed packages',()=>{
  const root=project()
  assert.throws(()=>resolveSDKPackageMetadata({environment:{SDK_RELEASE:'yes'},projectRoot:root}),/0 or 1/)
  assert.throws(()=>resolveSDKPackageMetadata({environment:{SDK_RELEASE_VERSION:'0.1.0-alpha.1'},projectRoot:root}),/requires SDK_RELEASE=1/)
  assert.throws(()=>resolveSDKPackageMetadata({environment:{SDK_RELEASE:'1',SDK_RELEASE_VERSION:'1.0.0',SDK_RELEASE_LICENSE:'MIT'},projectRoot:root}),/alpha semantic version/)
  assert.throws(()=>resolveSDKPackageMetadata({environment:{SDK_RELEASE:'1',SDK_RELEASE_VERSION:'0.1.0-alpha.1',SDK_RELEASE_LICENSE:'MITT'},projectRoot:root}),/supported SPDX/)
  assert.throws(()=>resolveSDKPackageMetadata({environment:{SDK_RELEASE:'1',SDK_RELEASE_VERSION:'0.1.0-alpha.1',SDK_RELEASE_LICENSE:'MIT'},projectRoot:root}),/LICENSE/)
  writeFileSync(join(root,'license-target'),'text')
  symlinkSync(join(root,'license-target'),join(root,'LICENSE'))
  assert.throws(()=>resolveSDKPackageMetadata({environment:{SDK_RELEASE:'1',SDK_RELEASE_VERSION:'0.1.0-alpha.1',SDK_RELEASE_LICENSE:'MIT'},projectRoot:root}),/regular file/)
})
