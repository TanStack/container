import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdtempSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import {verifyNativeCompilerPackage} from './native-runtime-build-plan.mjs'
import {buildNativeOxide,installNativeOxideBuild} from './build-native-oxide.mjs'
import {readPackageNotices} from './package-notices.mjs'
import {stageCompilerPackage} from './compiler-package-staging.mjs'

const root=fileURLToPath(new URL('..',import.meta.url))
const viteRoot=process.env.NATIVE_VITE_PACKAGE_ROOT?resolve(process.env.NATIVE_VITE_PACKAGE_ROOT):join(root,'node_modules/vite8-browser')
const rolldownRoot=process.env.NATIVE_ROLLDOWN_PACKAGE_ROOT?resolve(process.env.NATIVE_ROLLDOWN_PACKAGE_ROOT):join(root,'node_modules/@rolldown/browser')
const viteVersion=process.env.NATIVE_VITE_VERSION??'8.3.1'
const rolldownVersion=process.env.NATIVE_ROLLDOWN_VERSION??'1.2.11'
if(![viteVersion,rolldownVersion].every(version=>/^\d+\.\d+\.\d+$/.test(version)))throw Error('Native runtime compiler versions must be exact')
verifyNativeCompilerPackage(viteRoot,'vite',viteVersion)
verifyNativeCompilerPackage(rolldownRoot,'@rolldown/browser',rolldownVersion)
const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'))
const oxide=lock.packages?.['node_modules/@tailwindcss/oxide-wasm32-wasi']
if(oxide?.version!=='4.3.3'||typeof oxide.integrity!=='string'||!oxide.integrity.startsWith('sha512-'))
  throw Error('Native runtime requires locked @tailwindcss/oxide-wasm32-wasi@4.3.3')
const oxideURL=new URL(oxide.resolved)
if(oxideURL.href!=='https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.3.tgz')
  throw Error('Native Oxide package URL is not the pinned npm registry artifact')
const response=await fetch(oxideURL,{signal:AbortSignal.timeout(120000)})
if(!response.ok)throw Error(`Native Oxide package download failed: ${response.status}`)
const archive=Buffer.from(await response.arrayBuffer())
const actual='sha512-'+createHash('sha512').update(archive).digest('base64')
if(actual!==oxide.integrity)throw Error('Native Oxide package integrity mismatch')
const scratch=mkdtempSync(join(tmpdir(),'container-native-oxide-'))
const archivePath=join(scratch,'oxide.tgz')
writeFileSync(archivePath,archive,{flag:'wx'})
execFileSync('tar',['-xzf',archivePath,'-C',scratch],{stdio:'pipe'})
const extractedOxideRoot=join(scratch,'package')
const oxideManifest=JSON.parse(readFileSync(join(extractedOxideRoot,'package.json'),'utf8'))
if(oxideManifest.name!=='@tailwindcss/oxide-wasm32-wasi'||oxideManifest.version!=='4.3.3')
  throw Error('Extracted native Oxide package identity mismatch')
const ownedOxide=process.env.NATIVE_OXIDE_BUILD_ROOT?resolve(process.env.NATIVE_OXIDE_BUILD_ROOT):join(scratch,'source-build')
if(!process.env.NATIVE_OXIDE_BUILD_ROOT)await buildNativeOxide({projectRoot:root,output:ownedOxide})
const oxideBuild=installNativeOxideBuild(ownedOxide,extractedOxideRoot,root)
const {packageRoot:oxideRoot}=stageCompilerPackage(extractedOxideRoot,root)
const output=resolve(process.env.NATIVE_RUNTIME_OUTPUT??join(root,'public/native-runtime'))
execFileSync(process.execPath,[join(root,'scripts/build-browser-vite.mjs')],{
  cwd:root,stdio:'inherit',env:{...process.env,
    BROWSER_VITE_PACKAGE_ROOT:viteRoot,
    BROWSER_ROLLDOWN_PACKAGE_ROOT:rolldownRoot,
    BROWSER_OXIDE_PACKAGE_ROOT:oxideRoot,
    BROWSER_VITE_ENTRY_POINT:join(root,'src/native/dev-server-vite8-bootstrap.worker.ts'),
    BROWSER_VITE_OUTPUT_DIRECTORY:output,
  },
})
copyFileSync(join(root,'src/native/classic-worker-bootstrap.js'),join(output,'classic-worker-bootstrap.js'))
const inputsPath=join(output,'SHIPPED-INPUTS.json')
const inputs=JSON.parse(readFileSync(inputsPath,'utf8'))
inputs.workspaceInputs=[...new Set([...inputs.workspaceInputs,'src/native/classic-worker-bootstrap.js',
  'build-inputs/native-oxide.json','scripts/build-native-oxide.mjs','scripts/supplemental-rust-notices.mjs',
  'scripts/compiler-package-staging.mjs','scripts/compiler-input-paths.mjs',
  'licenses/upstream/napi-rs-wasm-runtime-1.2.4-LICENSE',oxideBuild.inputs.patch,
  'tests/fixtures/native-oxide-build/package.json','tests/fixtures/native-oxide-build/package-lock.json'])].sort()
for(const file of ['BUILD.json','RUST-INPUTS.json','RUST-NOTICES.txt'])
  copyFileSync(join(ownedOxide,file),join(output,'oxide',file))
inputs.ownedOxide={record:'oxide/BUILD.json',wasmSHA256:oxideBuild.wasm.sha256,
  revision:oxideBuild.inputs.revision,rustInputsSHA256:oxideBuild.rustInputsSHA256}
const rustInputs=JSON.parse(readFileSync(join(ownedOxide,'RUST-INPUTS.json'),'utf8'))
inputs.packages.push(...rustInputs.packages.map(pkg=>({name:'cargo:'+pkg.name,version:pkg.version,
  license:pkg.license,noticeTextPresent:pkg.notices.length>0,scope:'Oxide compiler input, not an exact linked-content claim'})))
const emnapiRoot=join(root,'tests/fixtures/native-oxide-build/node_modules/emnapi')
const emnapiNotices=readPackageNotices(emnapiRoot)
inputs.packages.push({name:'emnapi',version:oxideBuild.inputs.emnapiVersion,license:'MIT',noticeTextPresent:Boolean(emnapiNotices)})
inputs.missingNoticeText=[...new Set([...inputs.missingNoticeText,
  ...rustInputs.missingNoticeText.map(name=>'cargo:'+name),...(!emnapiNotices?['emnapi@'+oxideBuild.inputs.emnapiVersion]:[])])].sort()
inputs.noticeTextCoverageComplete=inputs.missingNoticeText.length===0
const noticePath=join(output,'THIRD-PARTY-NOTICES.txt')
const rustNotices=readFileSync(join(ownedOxide,'RUST-NOTICES.txt'),'utf8').replace(/^(\S+@\S+)\nDeclared license:/gm,'cargo:$1\nDeclared license:')
writeFileSync(noticePath,readFileSync(noticePath,'utf8')+'\n'+rustNotices+
  `\nemnapi@${oxideBuild.inputs.emnapiVersion}\nDeclared license: MIT\n${emnapiNotices}\n`)
writeFileSync(inputsPath,JSON.stringify(inputs,null,2)+'\n')
console.log(`NATIVE_RUNTIME_OUTPUT=${output}`)
