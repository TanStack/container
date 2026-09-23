import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {installedPackageInventory,verifyConsumerTypes} from '../scripts/test-sdk-packages.mjs'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
test('paired adoption inventory rejects changed, added and linked package files',()=>{
  for(const mutation of ['changed','extra','link']){
    const root=mkdtempSync(join(tmpdir(),'sdk-adoption-inventory-'))
    writeFileSync(join(root,'index.js'),'export const value = 1;')
    const bytes=readFileSync(join(root,'index.js'))
    writeFileSync(join(root,'package-assets.json'),JSON.stringify({format:1,files:[{path:'index.js',bytes:bytes.length,sha256:hash(bytes)}]}))
    assert.equal(installedPackageInventory(root).length,2)
    if(mutation==='changed')writeFileSync(join(root,'index.js'),'changed')
    else if(mutation==='extra')writeFileSync(join(root,'extra.js'),'extra')
    else symlinkSync(join(root,'index.js'),join(root,'linked.js'))
    assert.throws(()=>installedPackageInventory(root))
  }
})
test('consumer check uses installed public declarations in bundler and NodeNext modes',()=>{
  const root=mkdtempSync(join(tmpdir(),'sdk-adoption-types-'))
  writeFileSync(join(root,'package.json'),JSON.stringify({private:true,type:'module'}))
  const pkg=join(root,'node_modules/@tanstack/browser-sandbox-experimental');mkdirSync(pkg,{recursive:true})
  writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@tanstack/browser-sandbox-experimental',type:'module',exports:{'.':{types:'./index.d.ts',import:'./index.js'}}}))
  writeFileSync(join(pkg,'index.d.ts'),'export declare const version: number;')
  writeFileSync(join(root,'types-check.ts'),"import {version} from '@tanstack/browser-sandbox-experimental'; const value: number = version;")
  assert.deepEqual(verifyConsumerTypes(root),['bundler','nodenext'])
  writeFileSync(join(root,'types-check.ts'),"import {version} from '@tanstack/browser-sandbox-experimental'; const value: string = version;")
  assert.throws(()=>verifyConsumerTypes(root),/not assignable/)
})
