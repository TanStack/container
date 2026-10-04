import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createNativeOwnerHostAssets} from '../src/sdk/native-owner-host-assets.mjs'
test('owner configuration carries a validated optional build identity',()=>{
  const base={parentOrigin:'https://tanstack.com',previewOrigin:'https://sandbox-preview.example'}
  const buildId='build-"quoted"'
  assert.ok(createNativeOwnerHostAssets({...base,buildId}).files['/__sandbox/owner.js'].includes(`buildId: ${JSON.stringify(buildId)}`))
  assert.match(createNativeOwnerHostAssets(base).files['/__sandbox/owner.js'],/buildId: undefined/)
  for(const buildId of ['', 'has space', '\n', 'é', 'x'.repeat(257), null, 42])
    assert.throws(()=>createNativeOwnerHostAssets({...base,buildId}),/buildId/)
})
test('owner configuration carries an explicit runtime directory',()=>{
  const base={parentOrigin:'https://tanstack.com',previewOrigin:'https://sandbox-preview.example'}
  const assets=createNativeOwnerHostAssets({...base,assetBaseURL:'/sdk/runtime/'})
  assert.match(assets.files['/__sandbox/owner.js'],/assetBaseURL: "\/sdk\/runtime\/"/)
  for(const assetBaseURL of ['/sdk/runtime','/sdk/runtime/?x=1','https://other.example/runtime/','/sdk/../runtime/'])
    assert.throws(()=>createNativeOwnerHostAssets({...base,assetBaseURL}))
})
test('owner configuration carries hosted compiler candidates with exact versions',()=>{
  const base={parentOrigin:'https://tanstack.com',previewOrigin:'https://sandbox-preview.example'}
  const runtimeCandidates=[{workerURL:'/runtime/v11/engine.js',toolchain:{vite:'8.3.1',rolldown:'1.2.11'}}]
  const assets=createNativeOwnerHostAssets({...base,runtimeCandidates})
  assert.ok(assets.files['/__sandbox/owner.js'].includes(JSON.stringify(runtimeCandidates)))
  assert.throws(()=>createNativeOwnerHostAssets({...base,runtimeCandidates:[]}),/nonempty array/)
  assert.throws(()=>createNativeOwnerHostAssets({...base,runtimeCandidates:[{workerURL:'/runtime/engine.js',toolchain:{vite:'latest',rolldown:'1.2.11'}}]}),/exact compiler versions/)
})

test('owner files use an external module and exact, separate origins',()=>{
  const assets=createNativeOwnerHostAssets({
    parentOrigin:'https://tanstack.com',previewOrigin:'https://sandbox-preview.example',
  })
  assert.match(assets.files['/owner.html'],/src="\/__sandbox\/owner\.js"/)
  assert.doesNotMatch(assets.files['/owner.html'],/<script[^>]*>[^<]/)
  assert.match(assets.files['/__sandbox/owner.js'],/installNativeOwnerHost/)
  assert.match(assets.files['/__sandbox/owner.js'],/https:\/\/tanstack\.com/)
  assert.match(assets.files['/__sandbox/owner.js'],/\/runtime\/native\/engine\.js/)
  assert.equal(assets.headers['/owner.html']['Cross-Origin-Resource-Policy'],'cross-origin')
  assert.equal(assets.headers['/owner.html']['Cross-Origin-Embedder-Policy'],'require-corp')
})

test('owner files reject insecure or ambiguous origins and asset paths',()=>{
  const valid={parentOrigin:'https://tanstack.com',previewOrigin:'https://sandbox-preview.example'}
  for(const parentOrigin of ['http://tanstack.com','https://tanstack.com/path','https://tanstack.com/','https://tanstack.com?x=1'])
    assert.throws(()=>createNativeOwnerHostAssets({...valid,parentOrigin}))
  assert.throws(()=>createNativeOwnerHostAssets({...valid,previewOrigin:valid.parentOrigin}))
  for(const sdkPath of ['https://other.example/index.js','//other.example/index.js','/sdk/../index.js','/sdk/index.js?x=1'])
    assert.throws(()=>createNativeOwnerHostAssets({...valid,sdkPath}))
  assert.doesNotThrow(()=>createNativeOwnerHostAssets({parentOrigin:'http://127.0.0.1:4198',previewOrigin:'http://127.0.0.1:4199'}))
  assert.doesNotThrow(()=>createNativeOwnerHostAssets({parentOrigin:'http://127.0.0.1:4198',previewOrigin:'http://example.localhost:4199'}))
  assert.match(createNativeOwnerHostAssets({parentOrigin:'http://127.0.0.1:4198',previewOrigin:'http://127.0.0.1:4199',previewHostSuffix:'.localhost'}).files['/__sandbox/owner.js'],/previewHostSuffix: "\.localhost"/)
  assert.throws(()=>createNativeOwnerHostAssets({parentOrigin:'http://127.0.0.1:4198',previewOrigin:'http://example.localhost.evil.test:4199'}))
  assert.throws(()=>createNativeOwnerHostAssets({parentOrigin:'http://127.0.0.1:4198',previewOrigin:'http://127.0.0.1:4199',previewHostSuffix:'.localhost.evil/' }))
})
