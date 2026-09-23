import {expect,test} from 'vitest'
import {mkdtemp,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
// Build script runs in Node, outside the browser runtime.
// @ts-expect-error JavaScript build entry has no public runtime type declaration.
import {buildRolldownParser} from '../scripts/build-rolldown-parser.mjs'
test('build emits pinned standalone parser assets with provenance and no fixture runtime imports',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'rolldown-parser-build-'))
  const output=join(directory,'artifact')
  const metadata=await buildRolldownParser(resolve('tests/fixtures/rolldown-native-probe'),output)
  expect(metadata.enabledByDefault).toBe(false)
  expect(metadata.operations).toEqual(['parse','callable.create','callable.resolve','callable.invoke','callable.update','callable.dispose','bundler.create','bundler.run','bundler.context','bundler.close'])
  expect(metadata.bundler).toEqual({experimental:true,requiresOwnerWorkspace:true,methods:['generate','write','scan']})
  expect(metadata.callable).toEqual({builtin:'builtin:vite-resolve',builtins:['builtin:vite-resolve','builtin:oxc-runtime','builtin:vite-json'],requiresOwnerWorkspace:true,resolveHook:'resolveId',invokeHooks:['load','transform'],update:{files:'mirror',events:['create','update','delete'],hook:'watchChange'},callbacks:['resolveSubpathImports','onWarn','onDebug','finalizeBareSpecifier','finalizeOtherSpecifiers']})
  expect(metadata.resources).toEqual({full:{initialPages:4096,maximumPages:20480,maxWorkers:8,asyncWorkPoolSize:4},sync:{initialPages:1024,maximumPages:8192,maxWorkers:2,asyncWorkPoolSize:1},accounting:'Separate native compiler reservations, not included in the guest memory limit'})
  for(const [name,hash]of Object.entries(metadata.assets))expect(createHash('sha256').update(await readFile(join(output,name))).digest('hex')).toBe(hash)
  expect(await readFile(join(output,'worker.js'),'utf8')).not.toMatch(/from ["'].*tests\/fixtures/)
  expect(Object.keys(metadata.sources).length).toBeGreaterThan(3)
  expect(metadata.sources).toHaveProperty('workspace/src/compiler/rolldown-callable-protocol.ts')
  for(const name of ['rolldown-bundler-backend.ts','rolldown-bundler-workspace.ts','rolldown-binding-output.js'])expect(metadata.sources).toHaveProperty('workspace/src/compiler/'+name)
  expect(metadata.sources).toHaveProperty('workspace/src/compiler/restore-compiler-workspace.ts')
  await expect(buildRolldownParser(resolve('tests/fixtures/rolldown-native-probe'),output)).rejects.toThrow()
},30000)
