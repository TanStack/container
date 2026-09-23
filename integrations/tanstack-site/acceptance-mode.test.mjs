import test from 'node:test'
import assert from 'node:assert/strict'
import {acceptanceConfig,isolationHeaders,publicHTTPSURL,verifyDeployedIdentity} from './acceptance-mode.mjs'

const hash='a'.repeat(64),tarball='b'.repeat(64),integrity='sha512-YWJjZA=='
const env={TANSTACK_ACCEPTANCE_MODE:'deployed',TANSTACK_OWNER_URL:'https://tanstack.com/start/example',SDK_EXPECTED_PACKAGE_NAME:'@tanstack/browser-sandbox',SDK_EXPECTED_PACKAGE_VERSION:'1.2.3',SDK_EXPECTED_PACKAGE_INTEGRITY:integrity,SDK_MANIFEST_SHA256:hash,SDK_TARBALL_SHA256:tarball}

test('local mode keeps local defaults without production evidence',()=>assert.equal(acceptanceConfig({}).ownerUrl.origin,'http://127.0.0.1:4198'))
test('deployed mode requires every package binding',()=>assert.throws(()=>acceptanceConfig({...env,SDK_TARBALL_SHA256:''}),/SDK_TARBALL_SHA256 is required/))
for(const url of ['http://tanstack.com/x','https://localhost/x','https://127.0.0.1/x','https://192.168.1.2/x','https://sdk.local/x'])test(`deployed URL rejects ${url}`,()=>assert.throws(()=>publicHTTPSURL(url),/HTTPS|loopback/))
test('deployed identity accepts an exact public package and artifact binding',()=>{
  const config=acceptanceConfig(env)
  assert.equal(verifyDeployedIdentity({packageName:env.SDK_EXPECTED_PACKAGE_NAME,packageVersion:env.SDK_EXPECTED_PACKAGE_VERSION,packageIntegrity:integrity,packageResolved:'https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz',sdkManifestSHA256:hash,sdkTarballSHA256:tarball},config).actual.version,'1.2.3')
})
test('deployed identity rejects local and mismatched packages',()=>{
  const config=acceptanceConfig(env),identity={packageName:env.SDK_EXPECTED_PACKAGE_NAME,packageVersion:'1.2.3',packageIntegrity:integrity,packageResolved:'file:../sdk.tgz',sdkManifestSHA256:hash,sdkTarballSHA256:tarball}
  assert.throws(()=>verifyDeployedIdentity(identity,config),/must not use a file/)
  assert.throws(()=>verifyDeployedIdentity({...identity,packageResolved:'https://registry.npmjs.org/pkg.tgz',packageVersion:'9.9.9'},config),/version mismatch/)
})
test('header evidence retains missing isolation policy as null',()=>assert.deepEqual(isolationHeaders({'cross-origin-opener-policy':'same-origin'}),{'cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':null,'cross-origin-resource-policy':null,'content-security-policy':null,'permissions-policy':null}))
