import {readFileSync,lstatSync} from 'node:fs'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {collectInstalledClosure} from './collect-installed-closure.mjs'

const root=resolve(import.meta.dirname,'..')
const fixtures={
  astro:{
    spec:'tests/sdk-frameworks/astro-consumer.spec.ts',
    files:[
      'public/workloads/astro-build.json',
      'fixtures/workloads/generated/astro-build/dist/index.html',
    ],
  },
  start:{
    spec:'tests/sdk-frameworks/start-consumer.spec.ts',
    files:[
      'fixtures/install-start-wasm/package.json',
      'fixtures/install-start-wasm/package-lock.json',
      'fixtures/start-basic/vite.config.ts',
      'fixtures/start-basic/src/router.tsx',
      'fixtures/start-basic/src/routes/__root.tsx',
      'fixtures/start-basic/src/routes/index.tsx',
      'fixtures/start-basic/src/routes/about.tsx',
    ],
  },
  sveltekit:{
    spec:'tests/sdk-frameworks/sveltekit-consumer.spec.ts',
    files:[
      'fixtures/install-sveltekit-wasm/package.json',
      'fixtures/install-sveltekit-wasm/package-lock.json',
      'fixtures/install-sveltekit-wasm/vite.config.js',
      'fixtures/install-sveltekit-wasm/svelte.config.js',
      'fixtures/install-sveltekit-wasm/src/app.html',
      'fixtures/install-sveltekit-wasm/src/routes/+page.server.js',
      'fixtures/install-sveltekit-wasm/src/routes/+page.svelte',
      'fixtures/install-sveltekit-wasm/src/routes/api/+server.js',
    ],
  },
}

for(const [framework,fixture] of Object.entries(fixtures)){
  const source=readFileSync(resolve(root,fixture.spec),'utf8')
  for(const file of fixture.files){
    const stat=lstatSync(resolve(root,file))
    if(!stat.isFile()||stat.isSymbolicLink())throw Error(`${framework} fixture input must be a regular file: ${file}`)
  }
  if(!source.includes('import * as sdk from "./vendor/index.js"'))throw Error(`${framework} consumer does not import the packaged SDK entry`)
  if(!source.includes("preview-host/hosting.json"))throw Error(`${framework} consumer does not use the packaged preview-host contract`)
  if(/(?:from|import\s*\()\s*['"](?:\.\.\/)+(?:\.\.\/)*src\//.test(source))throw Error(`${framework} consumer imports repository runtime source`)
  if(!source.includes("realpathSync(process.env.SDK_OUTPUT!)"))throw Error(`${framework} consumer does not require a built SDK output`)
  if(framework==='astro'){
    const raw=readFileSync(resolve(root,'public/workloads/astro-build.json'))
    const snapshot=JSON.parse(raw)
    const files=snapshot.files
    if(snapshot.preparation?.kind!=='installed-dependency-closure')throw Error('astro needs a complete installed dependency closure, run node scripts/prepare-workloads.mjs --only=astro-build')
    const closure=await collectInstalledClosure(resolve(root,'fixtures/workloads'),['astro'])
    if(JSON.stringify(closure.preparation)!==JSON.stringify(snapshot.preparation))throw Error('astro installed dependency metadata changed, prepare the fixture again')
    for(const [name,value] of Object.entries(closure.files))if(files?.[name]?.base64!==value.base64)throw Error('astro installed dependency content is missing or stale: '+name)
    const prepared=JSON.parse(readFileSync(resolve(root,'public/workloads/manifest.json'),'utf8')).cases.find(row=>row.id==='astro-build')
    if(prepared?.preparation?.sha256!==createHash('sha256').update(raw).digest('hex'))throw Error('astro snapshot does not match its preparation manifest')
    const decode=path=>Buffer.from(files[path]?.base64??'','base64').toString('utf8')
    const manifest=JSON.parse(decode('/node_modules/astro/package.json'))
    if(manifest.version!=='7.3.2')throw Error(`astro fixture version changed: ${manifest.version}`)
    if(!decode('/main.mjs').includes("import {build} from 'astro'"))throw Error('astro fixture does not exercise the public build API')
    if(!readFileSync(resolve(root,'fixtures/workloads/generated/astro-build/dist/index.html'),'utf8').includes('Fixture 7'))throw Error('astro native static-build control is missing expected output')
  }
}

console.log(JSON.stringify({config:'playwright.sdk-frameworks.config.ts',frameworks:Object.keys(fixtures),fixtures},null,2))
