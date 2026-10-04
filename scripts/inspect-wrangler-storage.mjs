import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// File metadata only. Never reads database contents, follows links, or deletes.
export async function snapshotStorage(directory) {
  const requested = path.resolve(directory)
  if ((await lstat(requested)).isSymbolicLink())
    throw new Error('Choose the real directory, not a symbolic link.')
  const root = await realpath(requested)
  if (path.basename(root) !== '.wrangler')
    throw new Error('The target must be a .wrangler directory.')
  const files = new Map()
  const skipped = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      const relative = path.relative(root, filename)
      let stat
      try {
        stat = await lstat(filename)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        skipped.push({ path: relative, reason: 'disappeared during scan' })
        continue
      }
      if (stat.isSymbolicLink()) {
        skipped.push({ path: relative, reason: 'symbolic link' })
      } else if (stat.isDirectory()) {
        try {
          await walk(filename)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          skipped.push({ path: relative, reason: 'disappeared during scan' })
        }
      } else if (stat.isFile()) {
        files.set(relative, {
          path: relative,
          bytes: stat.size,
          allocatedBytes: stat.blocks * 512,
          modifiedAt: stat.mtime.toISOString(),
        })
      }
    }
  }
  await walk(root)
  const groups = new Map()
  for (const row of files.values()) {
    const group = path.dirname(row.path).split(path.sep).slice(0, 4).join('/')
    const total = groups.get(group) ?? { path: group, bytes: 0, allocatedBytes: 0, files: 0 }
    total.bytes += row.bytes
    total.allocatedBytes += row.allocatedBytes
    total.files++
    groups.set(group, total)
  }
  return {
    files,
    report: {
      root,
      capturedAt: new Date().toISOString(),
      consistency: 'Best-effort scan of a running server, not a database snapshot.',
      fileCount: files.size,
      bytes: [...files.values()].reduce((total, row) => total + row.bytes, 0),
      allocatedBytes: [...files.values()].reduce((total, row) => total + row.allocatedBytes, 0),
      groupCount: groups.size,
      groups: [...groups.values()].sort((a, b) => b.allocatedBytes - a.allocatedBytes).slice(0, 30),
      largestFiles: [...files.values()].sort((a, b) => b.allocatedBytes - a.allocatedBytes).slice(0, 20),
      skipped,
    },
  }
}

export function storageGrowth(before, after) {
  return [...new Set([...before.files.keys(), ...after.files.keys()])]
    .map((filename) => ({
      path: filename,
      bytesChanged: (after.files.get(filename)?.bytes ?? 0) - (before.files.get(filename)?.bytes ?? 0),
      allocatedBytesChanged: (after.files.get(filename)?.allocatedBytes ?? 0) - (before.files.get(filename)?.allocatedBytes ?? 0),
    }))
    .filter((row) => row.bytesChanged !== 0 || row.allocatedBytesChanged !== 0)
    .sort((a, b) => b.allocatedBytesChanged - a.allocatedBytesChanged)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [directory, seconds = '0', ...extra] = process.argv.slice(2)
  if (!directory || extra.length || !/^\d+$/.test(seconds) || Number(seconds) > 60)
    throw new Error('Usage: node scripts/inspect-wrangler-storage.mjs /absolute/path/.wrangler [seconds: 0..60]')
  const before = await snapshotStorage(directory)
  console.log(JSON.stringify({ stage: 'before', ...before.report }, null, 2))
  if (Number(seconds) > 0) {
    await delay(Number(seconds) * 1000)
    const after = await snapshotStorage(directory)
    console.log(JSON.stringify({
      stage: 'after', ...after.report,
      bytesChanged: after.report.bytes - before.report.bytes,
      allocatedBytesChanged: after.report.allocatedBytes - before.report.allocatedBytes,
      changedFiles: storageGrowth(before, after).slice(0, 40),
    }, null, 2))
  }
}
