import {expect,test} from 'vitest'
import {lightningcssPackageRoot,prepareLightningcss} from '../src/native/browser-lightningcss'

test('resolves top-level and nested Lightning CSS package scopes',()=>{
  expect(lightningcssPackageRoot('/app/node_modules/lightningcss/node/index.js'))
    .toBe('/app/node_modules/lightningcss')
  expect(lightningcssPackageRoot('/app/node_modules/@example/compiler/node_modules/lightningcss/node/index.js'))
    .toBe('/app/node_modules/@example/compiler/node_modules/lightningcss')
  expect(lightningcssPackageRoot('/node_modules/@example/compiler/node_modules/lightningcss/node/index.js'))
    .toBe('/app/node_modules/@example/compiler/node_modules/lightningcss')
  expect(lightningcssPackageRoot('/app/node_modules/not-lightningcss/node/index.js')).toBeUndefined()
})

test('does not initialize a CSS binding for projects without Lightning CSS',async()=>{
  await expect(prepareLightningcss([])).resolves.toBeUndefined()
})
