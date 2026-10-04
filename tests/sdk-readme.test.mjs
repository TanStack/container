import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import ts from 'typescript'
import {spawnSync} from 'node:child_process'

const readme=readFileSync('src/sdk/README.md','utf8')
const packages=readFileSync('src/sdk/PACKAGES.md','utf8')
for(const [guide,contents] of [['README',readme],['PACKAGES',packages]])test(`${guide} JavaScript-labeled examples are valid plain JavaScript`,()=>{
  const examples=[...contents.matchAll(/```js\n([\s\S]*?)```/g)]
  assert.ok(examples.length>0,`${guide} must retain runnable JavaScript examples`)
  for(const [index,match] of examples.entries()){
    const result=spawnSync(process.execPath,['--check','--input-type=module'],{input:match[1],encoding:'utf8'})
    assert.equal(result.status,0,`${guide} JavaScript block ${index+1}: ${result.stderr}`)
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
for(const [guide,contents,assetsTypes,minimumExamples] of [
  ['README',readme,'src/sdk/assets.d.ts',6],
  ['PACKAGES',packages,'src/sdk/package-assets.d.ts',2],
])test(`${guide} examples typecheck against their SDK entrypoints`,()=>{
  const examples=[...contents.matchAll(/```(?:ts|js)\n([\s\S]*?)```/g)].map(match=>match[1])
  assert.ok(examples.length>=minimumExamples,`${guide} must retain its ${minimumExamples} examples`)
  const config=ts.readConfigFile('tsconfig.json',ts.sys.readFile)
  assert.equal(config.error,undefined)
  const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd())
  const options={...parsed.options,baseUrl:process.cwd(),paths:{
    '@tanstack/browser-sandbox-experimental':['src/sdk/index.ts'],
    '@tanstack/browser-sandbox-experimental/assets':[assetsTypes],
  }}
  examples.forEach((source,index)=>{
    const filename=resolve(`src/sdk/${guide.toLowerCase()}-example-${index}.ts`)
    const host=ts.createCompilerHost(options),original=host.getSourceFile.bind(host)
    host.getSourceFile=(file,...args)=>resolve(file)===filename
      ?ts.createSourceFile(filename,source,options.target,true):original(file,...args)
    const program=ts.createProgram([filename,...parsed.fileNames.filter(file=>file.endsWith('.d.ts'))],options,host)
    const diagnostics=ts.getPreEmitDiagnostics(program)
    assert.equal(diagnostics.length,0,`${guide} code block ${index+1}\n`+ts.formatDiagnosticsWithColorAndContext(diagnostics,{
      getCanonicalFileName:file=>file,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n',
    }))
  })
})

test('the package builder ships and classifies the quickstart',()=>{
  const builder=readFileSync('scripts/build-sdk-packages.mjs','utf8')
  assert.match(builder,/writeFileSync\(join\(core,'README\.md'\),readFileSync\(join\(sourceRoot,'src\/sdk\/PACKAGES\.md'\)\)\)/)
  assert.match(readFileSync('scripts/sdk-notices.mjs','utf8'),/,'README\.md','COMPATIBILITY\.md'/)
  assert.match(readme,/separate origin/)
  assert.match(readme,/examples\/basic\//)
  assert.match(builder,/basic:\['README\.md','package\.json','index\.html','client\.js','server\.mjs','host\.mjs'\]/)
  assert.match(builder,/copy\(join\(sourceRoot,'examples','sdk-'\+name,file\),join\(core,'examples',name,file\)\)/)
  assert.match(packages,/await prepareRuntimeAssets\('public\/sandbox'\)/)
  assert.match(packages,/no postinstall hook and setup does not download packages/)
  assert.match(readme,/release build refuses to\nproduce a public package unless the repository has a regular `LICENSE` file/)
})

test('the adoption guide covers one public lifecycle and its boundaries',()=>{
  for(const step of ['session.install','kernel.spawn','URLPreview.mount','session.snapshot','session.restore'])assert.match(readme,new RegExp(step.replace('.','\\.')))
  for(const name of ['AgentSession','WorkerKernel','HostedKernel','WorkerHTTP','WorkerWebSocket','URLPreview','runShell','SandboxTelemetry','SDK_COMPATIBILITY','copyRuntimeAssets'])assert.match(readme,new RegExp('`'+name+'`'))
  for(const code of ['ERR_UNSUPPORTED_OPERATION','ERR_RESOURCE_LIMIT','ABORT_ERR','ENOENT','EACCES','EINVAL'])assert.match(readme,new RegExp(code))
  assert.match(readme,/no\s+automatic native-addon fallback, remote execution fallback or package rewrite/i)
  assert.match(readme,/Snapshots do not contain running\s+processes, open ports or host browser state/)
  assert.match(readme,/without filtering secrets, including credentials placed in `\.env` or other files/)
  assert.match(readme,/Treat snapshot exports as sensitive whenever the workspace contains secrets/)
  assert.match(readme,/## Threat model and isolation/)
  assert.match(readme,/not a hardened boundary for hostile code/)
  assert.match(readme,/dedicated\ncredential-free preview origin/)
  assert.match(readme,/@tanstack\/browser-sandbox-experimental@0\.1\.0-alpha\.0/)
})

test('the public split guide states isolation and snapshot sensitivity limits',()=>{
  assert.match(packages,/owner application, SDK and runtime assets are trusted/)
  assert.match(packages,/not get direct access to the user's device filesystem/)
  assert.match(packages,/separate, credential-free origin with the supplied hosting policy/)
  assert.match(packages,/not a hardened boundary for hostile code/)
  assert.match(packages,/Do not put owner credentials into guest files/)
  assert.match(packages,/Snapshots include saved workspace files without filtering secrets, including\s+`\.env` files/)
  assert.match(packages,/Keep snapshot exports private if the workspace contains sensitive data/)
})

test('the split guide links runnable examples that the package ships',()=>{
  const builder=readFileSync('scripts/build-sdk-packages.mjs','utf8')
  for(const name of ['basic','frameworks']){
    assert.ok(packages.includes(`(examples/${name}/README.md)`))
    assert.match(builder,new RegExp(name+":\\['README\\.md','package\\.json','index\\.html','client\\.js'"))
    assert.ok(readFileSync(`examples/sdk-${name}/README.md`,'utf8').includes('npm start'))
    const manifest=JSON.parse(readFileSync(`examples/sdk-${name}/package.json`,'utf8'))
    assert.equal(manifest.scripts.start,'node server.mjs')
    assert.ok(readFileSync(`examples/sdk-${name}/server.mjs`,'utf8').length>0)
  }
  assert.match(builder,/copy\(join\(sourceRoot,'examples','sdk-'\+name,file\),join\(core,'examples',name,file\)\)/)
  assert.match(packages,/Copy either example directory out of the installed SDK package/)
  assert.match(packages,/install matching local core\s+and runtime tarballs in that copied directory/)
  assert.match(packages,/Save, reload the page, resume\s+and run again/)
  assert.match(packages,/This does not load Vite or TanStack Start/)
  assert.match(packages,/Save, reload and resume the saved workspace without reinstalling dependencies/)
  assert.match(packages,/\[workflow compatibility\]\(COMPATIBILITY\.md\)/)
})

test('the package ships linked workflow compatibility with bounded historical claims',()=>{
  const compatibility=readFileSync('src/sdk/COMPATIBILITY.md','utf8')
  assert.match(readme,/\[workflow compatibility\]\(COMPATIBILITY\.md\)/)
  assert.match(readFileSync('scripts/build-sdk.mjs','utf8'),/cpSync\(resolve\('src\/sdk\/COMPATIBILITY\.md'\),join\(out,'COMPATIBILITY\.md'\)/)
  assert.match(readFileSync('scripts/sdk-notices.mjs','utf8'),/,'README\.md','COMPATIBILITY\.md'/)
  assert.match(compatibility,/bounded, artifact-specific results/)
  assert.match(compatibility,/split package contains `package-assets\.json`/)
  assert.match(compatibility,/asset setup writes `deployment-manifest\.json`/)
  assert.match(compatibility,/Browser acceptance is separate evidence bound to both package manifest hashes,\s+both npm tarball hashes and the prepared deployment hash/)
  assert.match(compatibility,/Split packages do not\s+ship the legacy `manifest\.json`, `candidate-compatibility\.json` or\s+`release-record\.json`/)
  assert.match(compatibility,/do not transfer passing results between different package pairs/)
  assert.match(compatibility,/Playwright WebKit evidence never substitutes for actual\nSafari evidence/)
  assert.match(compatibility,/representative workflows/)
  assert.match(compatibility,/not files shipped in the SDK/)
  const history=compatibility.split('## Legacy all-in-one candidate history')[1]
  assert.ok(history,'legacy evidence must be separated from split package acceptance')
  const candidates=[...history.matchAll(/^- \*\*[^*]+\*\*/gm)]
  assert.ok(candidates.length>0)
  assert.equal([...history.matchAll(/manifest SHA256\n\s+`[a-f0-9]{64}`/g)].length,candidates.length,'each historical candidate must identify its manifest bytes')
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
