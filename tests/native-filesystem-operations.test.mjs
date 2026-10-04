import test from 'node:test'
import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'

test('public filesystem consumers and the desktop workload pass strict TypeScript checks',()=>{
  const root=fileURLToPath(new URL('..',import.meta.url))
  const files=['filesystem-operations','volume-file-system','live-package-install','terminal-file-session',
    'sync-file-bridge','terminal-session','terminal-shell','terminal-processes'].map(name=>resolve(root,'src/native/'+name+'.ts'))
  files.push(resolve(root,'tests/fixtures/native-filesystem-consumer-workload.ts'))
  files.push(resolve(root,'tests/fixtures/native-filesystem-client-types.ts'))
  files.push(resolve(root,'src/native/filesystem-bootstrap.ts'),resolve(root,'src/native/filesystem-codec.d.ts'))
  const inputs=[...files,'src/vite-browser/node-fs.ts','src/vite-browser/events.d.ts',
    'src/vite-browser/shims.d.ts','src/npm/sha-js.d.ts','src/npm/semver.d.ts'].map(path=>resolve(root,path))
  const program=ts.createProgram(inputs,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,
    moduleResolution:ts.ModuleResolutionKind.Bundler,strict:true,skipLibCheck:true,noEmit:true,types:['node'],
    lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts','lib.webworker.d.ts']})
  const diagnostics=ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,
    {getCanonicalFileName:path=>path,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}))
})
