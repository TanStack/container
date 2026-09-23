import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {generateNodeAPISurface,renderNodeAPISurface} from '../scripts/node-api-surface.mjs'

it('identifies the exact builtin artifact without treating exports as behavior coverage',async()=>{
  const bytes=readFileSync('public/kernel-runtime/builtins.json')
  const report=await generateNodeAPISurface()
  expect(report.runtimeArtifactSHA256).toBe(createHash('sha256').update(bytes).digest('hex'))
  const fs=report.modules.find(row=>row.module==='node:fs')
  expect(fs?.present).toEqual(expect.arrayContaining(['readv','readvSync','writev','writevSync']))
  expect(fs?.missing).not.toEqual(expect.arrayContaining(['readv','writev']))
  const markdown=renderNodeAPISurface(report)
  expect(markdown).toContain(report.runtimeArtifactSHA256)
  expect(markdown).toContain('does not prove')
})
