import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import {buildSDKTypes} from '../scripts/build-sdk-types.mjs'

test('the native terminal guide compiles against public types with both module resolvers',()=>{
  const guide=readFileSync(new URL('../src/sdk/NATIVE_PACKAGES.md',import.meta.url),'utf8')
  const terminal=guide.split('## Terminal\n')[1]?.split('\n## Agent tools')[0]
  assert.ok(terminal,'Native adopters need a terminal guide')
  const snippets=[...terminal.matchAll(/```js\n([\s\S]*?)\n```/g)].map(match=>match[1])
  assert.equal(snippets.length,1)
  for(const method of ['openTerminalSession','runCommand','writeInput','endInput','result','dispose'])
    assert.ok(snippets[0].includes('.'+method),'Missing terminal lifecycle step: '+method)
  for(const method of ['interrupt','resize','writeInputAcknowledged'])
    assert.ok(terminal.includes('`command.'+method)||terminal.includes('`'+method+'`'),'Missing terminal control: '+method)
  const root=mkdtempSync(join(tmpdir(),'native-package-guide-'))
  writeFileSync(join(root,'package.json'),JSON.stringify({type:'module'}))
  const declarations=buildSDKTypes(root,{entry:'src/sdk/native.ts'})
  const consumer=join(root,'terminal.ts')
  writeFileSync(consumer,`import type {NativeOwnerClient} from '${declarations.entry.replace(/\.d\.ts$/,'.js')}';
declare const client: NativeOwnerClient;
declare const terminal: {write(text: string): void};
async function terminalExample() {
${snippets[0]}
}
`)
  for(const [module,moduleResolution]of [[ts.ModuleKind.ESNext,ts.ModuleResolutionKind.Bundler],[ts.ModuleKind.NodeNext,ts.ModuleResolutionKind.NodeNext]]){
    const program=ts.createProgram([consumer],{target:ts.ScriptTarget.ES2022,module,moduleResolution,
      strict:true,noEmit:true,skipLibCheck:false,types:[],lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts']})
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(item=>ts.flattenDiagnosticMessageText(item.messageText,'\n')),[])
  }
})
