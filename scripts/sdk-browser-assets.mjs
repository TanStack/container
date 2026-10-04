import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync,lstatSync} from 'node:fs'
import {join,resolve} from 'node:path'

/** Preserve package-relative module URLs without exposing Node-only helpers. */
export function sdkBrowserAssets(directory){
  const root=resolve(directory),manifest=JSON.parse(readFileSync(join(root,'package-assets.json'),'utf8'))
  assert.equal(manifest.format,1,'Unsupported SDK package inventory')
  const assets=new Map()
  for(const file of manifest.files){
    if(!['index.js','native.js'].includes(file.path)&&!/^(?:native|sdk)-chunks\/[A-Za-z0-9_-]+\.js$/.test(file.path))continue
    const url='/sdk/'+file.path,absolute=join(root,file.path)
    assert.ok(!assets.has(url),'Duplicate SDK module URL: '+url)
    for(const path of [root,...file.path.split('/').map((_,index,parts)=>join(root,...parts.slice(0,index+1)))])
      assert.ok(!lstatSync(path).isSymbolicLink(),'SDK browser module symlink: '+file.path)
    assert.ok(lstatSync(absolute).isFile(),'SDK browser module must be a file: '+file.path)
    const bytes=readFileSync(absolute)
    assert.equal(bytes.length,file.bytes,'SDK browser module size mismatch: '+file.path)
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,'SDK browser module hash mismatch: '+file.path)
    assets.set(url,absolute)
  }
  assert.ok(assets.has('/sdk/index.js'),'SDK package is missing its browser root')
  return assets
}
