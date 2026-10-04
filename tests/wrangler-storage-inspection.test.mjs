import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { snapshotStorage, storageGrowth } from '../scripts/inspect-wrangler-storage.mjs'

test('reports file growth without following links or reading contents', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wrangler-inspection-test-'))
  const root = path.join(parent, '.wrangler')
  await mkdir(path.join(root, 'state'), { recursive: true })
  await writeFile(path.join(root, 'state', 'db.sqlite'), 'abc')
  await writeFile(path.join(parent, 'outside.txt'), 'not part of the scan')
  await symlink(path.join(parent, 'outside.txt'), path.join(root, 'outside-link'))
  const before = await snapshotStorage(root)
  assert.equal(before.report.fileCount, 1)
  assert.equal(before.report.bytes, 3)
  assert.equal(before.report.skipped[0].reason, 'symbolic link')
  await writeFile(path.join(root, 'state', 'db.sqlite'), 'abcdef')
  await writeFile(path.join(root, 'state', 'db.sqlite-wal'), 'wal')
  const after = await snapshotStorage(root)
  assert.equal(after.report.bytes, 9)
  assert.deepEqual(storageGrowth(before, after).map((row) => [row.path, row.bytesChanged]).sort(), [
    ['state/db.sqlite', 3], ['state/db.sqlite-wal', 3],
  ])
  assert.equal(JSON.stringify(after.report).includes('abcdef'), false)
  await assert.rejects(snapshotStorage(parent), /must be a .wrangler directory/)
  const alias = path.join(parent, 'alias')
  await symlink(root, alias)
  await assert.rejects(snapshotStorage(alias), /not a symbolic link/)
})
