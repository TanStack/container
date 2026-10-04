import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {replaceWasiFsProxy} from '../../scripts/wasi-fs-proxy-transport.mjs'

// Use two ordinary locked installations, not copied codec source or a mock.
export function loadFilesystemCodecs(){
  const roots=[
    ['1.1.4',createRequire(new URL('./wasi-filesystem-codec-114/package.json',import.meta.url))],
    ['1.2.4',createRequire(import.meta.url)],
  ]
  return Object.fromEntries(roots.map(([version,require])=>{
    const root=dirname(require.resolve('@napi-rs/wasm-runtime'))
    assert.equal(JSON.parse(readFileSync(join(root,'package.json'))).version,version)
    const source=readFileSync(join(root,'fs-proxy.js'),'utf8')
    const transport=new URL('../../src/native/wasi-fs-transport.mjs',import.meta.url).href
    const transformed=replaceWasiFsProxy(source,transport)+'\nexport {decodeValue};'
    return [version,{root,source,sha256:createHash('sha256').update(source).digest('hex'),
      url:'data:text/javascript;base64,'+Buffer.from(transformed).toString('base64')}]
  }))
}
