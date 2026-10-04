import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPinnedNativeExamples } from './native-example-sources.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const key = process.argv[2] ?? 'react/start-counter'
const source = readPinnedNativeExamples(root).examples.get(key)
assert.ok(source, 'Unknown pinned example: ' + key)
const directory = mkdtempSync('/private/tmp/native-node-control-')
for (const [filename, contents] of Object.entries(source.files)) {
  assert.ok(filename.startsWith('/project/'))
  const relative = filename.slice('/project/'.length)
  assert.ok(relative && relative.split('/').every(part => part && part !== '.' && part !== '..'))
  const target = resolve(directory, relative)
  assert.ok(target.startsWith(directory + '/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof contents === 'string' ? contents : Buffer.from(contents))
}
console.log(JSON.stringify({ directory, key, revision: source.revision,
  sourceSHA256: source.sourceSHA256, npmLockSHA256: source.npmLockSHA256 }, null, 2))
