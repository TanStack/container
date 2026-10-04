import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {chromium,firefox,webkit} from '@playwright/test'

const sdkRoot=process.env.NATIVE_SDK_BUNDLE_DIR
test('installed generated owner host checks configured build identity in desktop browsers',{
  skip:!sdkRoot?'Set NATIVE_SDK_BUNDLE_DIR to an installed SDK package':false,
},async()=>{
  const {createNativeOwnerHostAssets}=await import(pathToFileURL(join(sdkRoot,'assets.mjs')).href)
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)))
  const close=server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
  let assets
  const serveSDK=async response=>{
    response.setHeader('Content-Type','text/javascript')
    response.end(await readFile(join(sdkRoot,'index.js')))
  }
  const parent=createServer(async(request,response)=>{
    if(request.url==='/sdk/index.js')return serveSDK(response)
    response.setHeader('Content-Type','text/html')
    response.end('<!doctype html><iframe id="owner"></iframe>')
  })
  const owner=createServer(async(request,response)=>{
    if(request.url==='/sdk/index.js')return serveSDK(response)
    const file=assets.files[request.url]
    if(file===undefined){response.writeHead(404);response.end();return}
    for(const [name,value] of Object.entries(assets.headers[request.url]))response.setHeader(name,value)
    response.end(file)
  })
  const preview=createServer((request,response)=>{response.writeHead(503);response.end()})
  try{
    const parentOrigin=await listen(parent),ownerOrigin=await listen(owner),previewOrigin=await listen(preview)
    assets=createNativeOwnerHostAssets({parentOrigin,previewOrigin,buildId:'generated-build'})
    for(const engine of [chromium,firefox,webkit]){
      const browser=await engine.launch({headless:true})
      try{
        const page=await browser.newPage()
        await page.goto(parentOrigin)
        const result=await page.evaluate(async({ownerOrigin})=>{
          const {NativeOwnerClient}=await import('/sdk/index.js')
          const frame=document.querySelector('#owner')
          await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('Generated owner did not become ready')),10000)
            const ready=event=>{
              if(event.origin!==ownerOrigin||event.data!=='native-owner-ready')return
              clearTimeout(timer);removeEventListener('message',ready);resolve()
            }
            addEventListener('message',ready);frame.src=ownerOrigin+'/owner.html'
          })
          let mismatch
          try{const client=await NativeOwnerClient.connect(frame.contentWindow,ownerOrigin,undefined,{expectedBuildId:'wrong-build'});client.close()}
          catch(error){mismatch=String(error)}
          const client=await NativeOwnerClient.connect(frame.contentWindow,ownerOrigin,undefined,{expectedBuildId:'generated-build'})
          client.close()
          return {mismatch,connected:true}
        },{ownerOrigin})
        assert.match(result.mismatch,/identity mismatch/)
        assert.equal(result.connected,true)
        console.log(`${engine.name()}: generated installed owner rejects mismatch and accepts matching identity`)
      }finally{await browser.close()}
    }
  }finally{await Promise.all([close(parent),close(owner),close(preview)])}
})
