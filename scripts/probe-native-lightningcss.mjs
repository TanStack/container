import {createRequire} from 'node:module'
import {mkdtemp,copyFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createServer} from 'vite'
import {chromium,firefox,webkit} from 'playwright'

const require=createRequire(import.meta.url)
const packageRoot=resolve(process.env.BROWSER_LIGHTNINGCSS_PACKAGE_ROOT||'')
if(!process.env.BROWSER_LIGHTNINGCSS_PACKAGE_ROOT)throw Error('Set BROWSER_LIGHTNINGCSS_PACKAGE_ROOT to the extracted lightningcss-wasm package')
const output=await mkdtemp(join(tmpdir(),'native-lightningcss-probe-'))
const esbuild=require('esbuild')
await esbuild.build({
  entryPoints:[join(packageRoot,'index.mjs')],
  outfile:join(output,'bundle.js'),bundle:true,format:'esm',platform:'browser',
  alias:{'napi-wasm':join(packageRoot,'node_modules/napi-wasm/index.mjs')},
})
await copyFile(join(packageRoot,'lightningcss_node.wasm'),join(output,'lightningcss_node.wasm'))
const server=await createServer({
  root:output,server:{host:'127.0.0.1',port:0},configFile:false,
  plugins:[{name:'probe-document',configureServer(server){server.middlewares.use((request,response,next)=>{
    if(request.url!=='/')return next()
    response.setHeader('Content-Type','text/html')
    response.end('<!doctype html><title>Lightning CSS WASM probe</title>')
  })}}],
})
await server.listen()
const origin=server.resolvedUrls.local[0]
try{
  for(const browserType of [chromium,firefox,webkit]){
    const browser=await browserType.launch({headless:true})
    try{
      const page=await browser.newPage()
      await page.goto(origin)
      const result=await page.evaluate(async()=>{
        const css=await import('/bundle.js')
        await css.default(fetch('/lightningcss_node.wasm').then(response=>response.arrayBuffer()))
        const output=css.transform({filename:'test.css',code:new TextEncoder().encode('.x { color: red }'),minify:true})
        return new TextDecoder().decode(output.code)
      })
      if(result!=='.x{color:red}')throw Error(`${browserType.name()} returned ${JSON.stringify(result)}`)
      console.log(`${browserType.name()}: ${result}`)
    }finally{await browser.close()}
  }
}finally{await server.close()}
