import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {build} from 'esbuild'
import {chromium,firefox,webkit} from '@playwright/test'

const lock=JSON.parse(await readFile('fixtures/native-real-counter/package-lock.json','utf8'))
const version=process.env.NATIVE_ROLLDOWN_PROBE_VERSION??lock.packages['node_modules/rolldown']?.version
assert.match(version,/^\d+\.\d+\.\d+$/)
const output=await mkdtemp(join(tmpdir(),'native-rolldown-browser-'))
const tarball=execFileSync('npm',['pack',`@rolldown/browser@${version}`,'--pack-destination',output,'--silent'],{encoding:'utf8'}).trim()
assert.match(tarball,/^rolldown-browser-\d+\.\d+\.\d+\.tgz$/)
const entries=execFileSync('tar',['-tzf',join(output,tarball)],{encoding:'utf8'}).trim().split('\n')
assert(entries.length>0&&entries.every(entry=>entry.startsWith('package/')&&!entry.split('/').includes('..')))
const extracted=join(output,'extracted')
await mkdir(extracted)
execFileSync('tar',['-xzf',join(output,tarball),'-C',extracted])
const source=join(extracted,'package/dist')
const fixtureModules=resolve('tests/fixtures/rolldown-native-probe/node_modules')
const entry=join(output,'probe-rolldown.js')
const worker=join(output,'probe-worker.js')
for(const [input,outfile] of [
  ['index.browser.mjs',entry],
  ['wasi-worker-browser.mjs',worker],
])await build({entryPoints:[join(source,input)],bundle:true,platform:'browser',format:'esm',target:'es2022',nodePaths:[fixtureModules],outfile})

const assets=new Map([
  ['/probe-rolldown.js',entry],
  ['/rolldown-binding.wasm32-wasi.wasm',join(source,'rolldown-binding.wasm32-wasi.wasm')],
  ['/wasi-worker-browser.mjs',worker],
])
const server=createServer(async(request,response)=>{
  const path=new URL(request.url,'http://localhost').pathname
  if(path!=='/plain'){
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy',path==='/credentialless'?'credentialless':'require-corp')
  }
  if(path==='/'||path==='/credentialless'||path==='/plain'){
    response.setHeader('Content-Type','text/html')
    response.end('<!doctype html><title>Rolldown browser probe</title>')
    return
  }
  const file=assets.get(path)
  if(!file){response.statusCode=404;response.end('Missing probe asset');return}
  try{
    response.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':'text/javascript')
    response.end(await readFile(file))
  }catch(error){response.statusCode=500;response.end(String(error))}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin=`http://127.0.0.1:${server.address().port}`
const results=[]
try{
  for(const kind of [chromium,firefox,webkit]){
    const browser=await kind.launch({headless:true})
    try{
      for(const [headerMode,path] of [['require-corp','/'],['credentialless','/credentialless']]){
        const page=await browser.newPage()
        try{
          // This bounds a feasibility run. It is not a production worker policy.
          await page.addInitScript(()=>Object.defineProperty(navigator,'hardwareConcurrency',{value:2,configurable:true}))
          await page.goto(origin+path)
          const result=await page.evaluate(async()=>{
            try{
              const {rolldown}=await import('/probe-rolldown.js')
              const bundle=await rolldown({
                cwd:'/app',input:'entry.js',
                plugins:[{name:'virtual-project',resolveId(id){return id},load(id){
                  if(id==='entry.js')return 'import {value} from "./value.js";export default value+1'
                  if(id==='./value.js')return 'export const value=41'
                }}],
              })
              try{
                const generated=await bundle.generate({format:'es'})
                return {isolated:crossOriginIsolated,ok:true,code:generated.output[0].code}
              }finally{await bundle.close()}
            }catch(error){return {isolated:crossOriginIsolated,ok:false,error:String(error)}}
          })
          results.push({browser:kind.name(),browserVersion:browser.version(),headerMode,...result})
        }finally{await page.close()}
      }
    }finally{await browser.close()}
  }
  const browser=await chromium.launch({headless:true})
  try{
    const page=await browser.newPage()
    await page.addInitScript(()=>Object.defineProperty(navigator,'hardwareConcurrency',{value:2,configurable:true}))
    await page.goto(origin+'/plain')
    const result=await page.evaluate(async()=>{
      try{await import('/probe-rolldown.js');return {isolated:crossOriginIsolated,loaded:true}}
      catch(error){return {isolated:crossOriginIsolated,loaded:false,error:String(error)}}
    })
    results.push({browser:'chromium-nonisolated',...result})
  }finally{await browser.close()}
}finally{await new Promise(resolve=>server.close(resolve))}
console.log(JSON.stringify({rolldownVersion:version,temporaryDirectory:output,results},null,2))
for(const result of results.filter(result=>result.browser!=='chromium-nonisolated')){
  assert.equal(result.isolated,true,result.browser)
  assert.equal(result.ok,true,`${result.browser}: ${result.error}`)
  assert.match(result.code,/entry_default = 42/)
}
const plain=results.find(result=>result.browser==='chromium-nonisolated')
assert.equal(plain.isolated,false)
assert.equal(plain.loaded,false)
assert.match(plain.error,/SharedArrayBuffer transfer requires self\.crossOriginIsolated/)
