import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {resolve,sep} from 'node:path'
import {chromium,firefox,webkit,expect} from '@playwright/test'

const sdk=process.env.NATIVE_SDK_BUNDLE_DIR
const payload='preview asset '+ 'x'.repeat(5000)
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(`http://127.0.0.1:${server.address().port}`)))
const close=server=>new Promise((done,fail)=>server.close(error=>error?fail(error):done()))

test('built HTML loads split chunks and CSS through the URL preview',{skip:!sdk},async()=>{
  const assets={}
  for(const name of ['bridge.html','bridge.js','sw.js','inspect.js','websocket.js'])
    assets['/__sandbox/'+name]=await readFile(resolve('preview-host',name))
  const policy=JSON.parse(await readFile(resolve('src/sandbox/request-policy.json'),'utf8'))
  assets['/__sandbox/request-policy.js']=Buffer.from(`self.SANDBOX_REQUEST_TIMEOUT_MS=${JSON.stringify(policy.maxRequestTimeoutMs)};`)
  const headers=response=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    response.setHeader('Cross-Origin-Resource-Policy','cross-origin')
  }
  const host=createServer(async(request,response)=>{
    headers(response)
    const path=new URL(request.url,'http://localhost').pathname
    if(path.startsWith('/sdk/')||path.startsWith('/runtime/')){
      const root=resolve(sdk),file=resolve(root,path.startsWith('/sdk/')?path.slice(5):path.slice(1))
      if(!file.startsWith(root+sep)){response.writeHead(404);response.end();return}
      try{
        response.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':/\.m?js$/.test(file)?'text/javascript':'application/octet-stream')
        response.end(await readFile(file))
      }catch{response.writeHead(404);response.end()}
      return
    }
    response.setHeader('Content-Type','text/html');response.end('<!doctype html><div id="preview"></div>')
  })
  const previewHost=createServer((request,response)=>{
    headers(response)
    const path=new URL(request.url,'http://localhost').pathname,asset=assets[path]
    if(!asset){response.writeHead(503);response.end('No workspace attached');return}
    response.setHeader('Content-Type',path.endsWith('.html')?'text/html':'text/javascript')
    response.setHeader('Cache-Control','no-store');response.setHeader('Service-Worker-Allowed','/')
    if(path.endsWith('.html'))response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'")
    response.end(asset)
  })
  try{
    const hostOrigin=await listen(host),previewOrigin=await listen(previewHost)
    for(const engine of [chromium,firefox,webkit]){
      const browser=await engine.launch({headless:true})
      try{
        const page=await browser.newPage(),requests=[]
        page.on('request',request=>{if(request.url().startsWith(previewOrigin+'/assets/'))requests.push(request.url())})
        page.on('pageerror',error=>console.log(engine.name(),error.message))
        await page.goto(hostOrigin)
        const build=await page.evaluate(async({previewOrigin,payload})=>{
          const {NativeDevServer,URLPreview}=await import('/sdk/index.js')
          const files={
            '/app/package.json':JSON.stringify({type:'module',scripts:{build:'vite build'},dependencies:{vite:'8.3.1',rolldown:'1.2.11',lightningcss:'1.33.0','is-number':'7.0.0'}}),
            '/app/server.js':'export default {fetch(){return new Response("waiting")}}',
            '/app/index.html':'<script type="module" src="/main.js"></script>',
            '/app/main.js':'import "./style.css";document.body.innerHTML=`<button>Load chunk</button><p id="result">ready</p>`;document.querySelector("button").onclick=async()=>{const value=await import("./lazy.js");const asset=await value.readAsset();document.body.dataset.asset=asset.body;document.body.dataset.assetUrl=asset.url;document.body.dataset.moduleUrl=asset.moduleURL;document.querySelector("#result").textContent=String(value.answer)};',
            '/app/lazy.js':'import isNumber from "is-number";export const answer=isNumber(42)?42:-1;export async function readAsset(){const url=new URL("./payload.txt",import.meta.url);const response=await fetch(url);if(!response.ok)throw Error("Asset request failed: "+response.status);return {body:await response.text(),url:url.href,moduleURL:import.meta.url}}',
            '/app/payload.txt':payload,
            '/app/style.css':'#result{color:rgb(0,128,0)}',
          }
          window.dev=new NativeDevServer(files,{workerURL:'/runtime/native/engine.js',installCommand:'npm install',entry:'server.js',serveFetchEntry:true,staticRoot:'/app/dist'})
          const port=await window.dev.ready
          const build=await window.dev.terminalCommand('npm run build','/app')
          if(build.exitCode!==0)throw Error(JSON.stringify(build))
          window.preview=await URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server:window.dev.previewServer(port)})
          window.preview.frame.id='app-preview'
          return {exitCode:build.exitCode}
        },{previewOrigin,payload})
        assert.equal(build.exitCode,0)
        const frame=page.frameLocator('#app-preview')
        await expect(frame.locator('#result')).toHaveText('ready')
        await expect(frame.locator('#result')).toHaveCSS('color','rgb(0, 128, 0)')
        const before=new Set(requests)
        await frame.getByRole('button',{name:'Load chunk'}).click()
        await expect(frame.locator('#result')).toHaveText('42')
        await expect(frame.locator('body')).toHaveAttribute('data-asset',payload)
        const assetURL=await frame.locator('body').getAttribute('data-asset-url')
        const moduleURL=await frame.locator('body').getAttribute('data-module-url')
        assert.ok(assetURL.startsWith(previewOrigin+'/assets/')&&assetURL.endsWith('.txt'),'asset URL belongs to the preview')
        assert.ok(moduleURL.startsWith(previewOrigin+'/assets/')&&moduleURL.endsWith('.js'),'import.meta.url identifies the served module')
        assert.ok(requests.includes(assetURL),'emitted asset requested over the URL preview')
        assert.ok(requests.some(url=>!before.has(url)&&url.endsWith('.js')),'lazy chunk requested after click')
        console.log(engine.name(),'split-chunk URL preview passed')
      }finally{await browser.close()}
    }
  }finally{await Promise.all([close(host),close(previewHost)])}
})
