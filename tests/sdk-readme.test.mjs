import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import ts from 'typescript'
import {spawnSync} from 'node:child_process'

const readme=readFileSync('src/sdk/README.md','utf8')
test('JavaScript-labeled examples are valid plain JavaScript',()=>{
  for(const [index,match] of [...readme.matchAll(/```js\n([\s\S]*?)```/g)].entries()){
    const result=spawnSync(process.execPath,['--check','--input-type=module'],{input:match[1],encoding:'utf8'})
    assert.equal(result.status,0,`JavaScript block ${index+1}: ${result.stderr}`)
  }
})

test('owner headers apply to HTML independently of the profile JSON response',()=>{
  const block=[...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map(match=>match[1]).find(source=>source.includes('function applySandboxOwnerHeaders'))
  assert.ok(block)
  const parsed=ts.createSourceFile('owner.ts',block,ts.ScriptTarget.ESNext,true)
  const functions=parsed.statements.filter(ts.isFunctionDeclaration).map(node=>node.getText(parsed)).join('\n')
  const js=ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText
  const runtime={ownerHeaders:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}
  const helpers=new Function('runtime',js+';return {applySandboxOwnerHeaders,sendRuntimeProfile}')(runtime)
  const htmlHeaders={},jsonHeaders={}
  let json
  helpers.applySandboxOwnerHeaders({setHeader:(name,value)=>{htmlHeaders[name]=value}})
  helpers.sendRuntimeProfile({setHeader:(name,value)=>{jsonHeaders[name]=value},end:value=>{json=value}})
  assert.deepEqual(htmlHeaders,runtime.ownerHeaders)
  assert.deepEqual(jsonHeaders,{'Content-Type':'application/json'})
  assert.deepEqual(JSON.parse(json),runtime)
})
test('quickstart examples typecheck against the public SDK entrypoints',()=>{
  const examples=[...readme.matchAll(/```(?:ts|js)\n([\s\S]*?)```/g)].map(match=>match[1])
  assert.equal(examples.length,6)
  const config=ts.readConfigFile('tsconfig.json',ts.sys.readFile)
  assert.equal(config.error,undefined)
  const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd())
  const options={...parsed.options,baseUrl:process.cwd(),paths:{
    '@tanstack/browser-sandbox-experimental':['src/sdk/index.ts'],
    '@tanstack/browser-sandbox-experimental/assets':['src/sdk/assets.d.ts'],
  }}
  examples.forEach((source,index)=>{
    const filename=resolve(`src/sdk/readme-example-${index}.ts`)
    const host=ts.createCompilerHost(options),original=host.getSourceFile.bind(host)
    host.getSourceFile=(file,...args)=>resolve(file)===filename
      ?ts.createSourceFile(filename,source,options.target,true):original(file,...args)
    const program=ts.createProgram([filename,...parsed.fileNames.filter(file=>file.endsWith('.d.ts'))],options,host)
    const diagnostics=ts.getPreEmitDiagnostics(program)
    assert.equal(diagnostics.length,0,`README code block ${index+1}\n`+ts.formatDiagnosticsWithColorAndContext(diagnostics,{
      getCanonicalFileName:file=>file,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n',
    }))
  })
})

test('the package builder ships and classifies the quickstart',()=>{
  assert.match(readFileSync('scripts/build-sdk.mjs','utf8'),/cpSync\(resolve\('src\/sdk\/README\.md'\),join\(out,'README\.md'\)/)
  assert.match(readFileSync('scripts/sdk-notices.mjs','utf8'),/,'README\.md','COMPATIBILITY\.md'/)
  assert.match(readme,/separate origin/)
  assert.match(readme,/examples\/basic\//)
  assert.match(readFileSync('scripts/build-sdk.mjs','utf8'),/join\(out,'examples','basic'\)/)
  assert.match(readme,/release build refuses to\nproduce a public package unless the repository has a regular `LICENSE` file/)
})

test('the adoption guide covers one public lifecycle and its boundaries',()=>{
  for(const step of ['session.install','kernel.spawn','URLPreview.mount','session.snapshot','session.restore'])assert.match(readme,new RegExp(step.replace('.','\\.')))
  for(const name of ['AgentSession','WorkerKernel','HostedKernel','WorkerHTTP','WorkerWebSocket','URLPreview','runShell','SandboxTelemetry','SDK_COMPATIBILITY','copyRuntimeAssets'])assert.match(readme,new RegExp('`'+name+'`'))
  for(const code of ['ERR_UNSUPPORTED_OPERATION','ERR_RESOURCE_LIMIT','ABORT_ERR','ENOENT','EACCES','EINVAL'])assert.match(readme,new RegExp(code))
  assert.match(readme,/no\s+automatic native-addon fallback, remote execution fallback or package rewrite/i)
  assert.match(readme,/Snapshots do not contain\nrunning processes, open ports, browser state or credentials/)
  assert.match(readme,/## Threat model and isolation/)
  assert.match(readme,/not a hardened boundary for hostile code/)
  assert.match(readme,/dedicated\ncredential-free preview origin/)
  assert.match(readme,/@tanstack\/browser-sandbox-experimental@0\.1\.0-alpha\.0/)
})

test('the package ships linked workflow compatibility with bounded historical claims',()=>{
  const compatibility=readFileSync('src/sdk/COMPATIBILITY.md','utf8')
  assert.match(readme,/\[workflow compatibility\]\(COMPATIBILITY\.md\)/)
  assert.match(readFileSync('scripts/build-sdk.mjs','utf8'),/cpSync\(resolve\('src\/sdk\/COMPATIBILITY\.md'\),join\(out,'COMPATIBILITY\.md'\)/)
  assert.match(readFileSync('scripts/sdk-notices.mjs','utf8'),/,'README\.md','COMPATIBILITY\.md'/)
  assert.match(compatibility,/bounded results/)
  assert.match(compatibility,/`candidate-compatibility\.json` is\nthe authoritative matrix/)
  assert.match(compatibility,/Chromium,\nFirefox, actual Safari and Playwright WebKit separately/)
  assert.match(compatibility,/Playwright WebKit evidence never substitutes for actual\nSafari evidence/)
  assert.match(compatibility,/representative workflows/)
  assert.match(compatibility,/not files shipped in\nthe SDK/)
  assert.equal([...compatibility.matchAll(/manifest SHA256\n\s+`[a-f0-9]{64}`/g)].length,1)
  assert.match(compatibility,/QfShkO/)
  assert.match(compatibility,/Actual Safari remains unverified/)
  assert.doesNotMatch(compatibility,/examples\/sdk-frameworks/)
  const projects=JSON.parse(readFileSync('examples/sdk-frameworks/projects.json','utf8'))
  for(const files of Object.values(projects)){
    const manifest=JSON.parse(files['/project/package.json'])
    assert.ok(compatibility.includes('Vite '+manifest.devDependencies.vite))
    assert.ok(compatibility.includes('Rollup WASM '+manifest.overrides.rollup.split('@').at(-1)))
    assert.ok(compatibility.includes('esbuild WASM '+manifest.overrides.esbuild.split('@').at(-1)))
    if(manifest.dependencies?.['@tanstack/react-start'])assert.ok(compatibility.includes('`@tanstack/react-start` '+manifest.dependencies['@tanstack/react-start']))
  }
})
