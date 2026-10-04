import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {nativeReleaseExamples,nativeExampleHash,readPinnedNativeExamples} from './native-example-sources.mjs'

export function captureNativeExampleSources(source,root=process.cwd(),output=join(root,'tests/fixtures/native-owner-sources')){
  source=resolve(source);root=resolve(root);output=resolve(output)
  assert.ok(!existsSync(output),'Native example source destination must be new')
  const git=args=>execFileSync('git',['-C',source,...args],{maxBuffer:16*1024*1024})
  const revision=git(['rev-parse','HEAD']).toString('utf8').trim()
  assert.match(revision,/^[0-9a-f]{40}$/)
  const snapshots=nativeReleaseExamples.map(example=>{
    const prefix=`examples/${example.kind}/${example.path}/`
    const paths=git(['ls-files','-z','--',prefix]).toString('utf8').split('\0').filter(Boolean).sort()
    assert.ok(paths.length,'Missing native example source: '+prefix)
    const files=paths.map(path=>{
      assert.ok(path.startsWith(prefix),'Unexpected native example source path')
      const bytes=git(['show',`${revision}:${path}`])
      assert.deepEqual(readFileSync(join(source,path)),bytes,'Native example source has uncommitted edits: '+path)
      return {path:path.slice(prefix.length),bytes:bytes.length,sha256:nativeExampleHash(bytes),base64:bytes.toString('base64')}
    })
    const bytes=Buffer.from(JSON.stringify({files},null,2)+'\n')
    return {entry:{...example,snapshot:`${example.kind}-${example.path}.json`,sha256:nativeExampleHash(bytes),
      npmLockSHA256:nativeExampleHash(readFileSync(join(root,'fixtures',example.fixture,'package-lock.json')))},bytes}
  })
  const license=git(['show',`${revision}:LICENSE`])
  mkdirSync(output,{recursive:true})
  for(const {entry,bytes} of snapshots)writeFileSync(join(output,entry.snapshot),bytes,{flag:'wx'})
  writeFileSync(join(output,'LICENSE'),license,{flag:'wx'})
  writeFileSync(join(output,'manifest.json'),JSON.stringify({format:1,repository:'https://github.com/TanStack/router.git',
    revision,licenseSHA256:nativeExampleHash(license),examples:snapshots.map(item=>item.entry)},null,2)+'\n',{flag:'wx'})
  const captured=readPinnedNativeExamples(root,output)
  console.log(JSON.stringify({directory:output,revision,examples:captured.examples.size,manifestSHA256:captured.manifestSHA256}))
  return captured
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,3,'Usage: node scripts/capture-native-example-sources.mjs ROUTER_CHECKOUT')
  captureNativeExampleSources(process.argv[2])
}
