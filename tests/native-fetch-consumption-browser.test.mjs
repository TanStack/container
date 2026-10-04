import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {chromium,firefox,webkit} from '@playwright/test'
import {installFetchConsumptionObservation} from '../scripts/native-fetch-consumption-observation.mjs'

test('consumption tracing preserves real browser JSON, clone and streamed reads',{
  skip:process.env.NATIVE_FETCH_CONSUMPTION_BROWSER!=='1'?'Opt-in browser diagnostic control':false,
  timeout:60000,
},async()=>{
  const server=createServer((request,response)=>{
    if(request.url==='/rpc/json'){
      response.setHeader('Content-Type','application/json')
      response.end(JSON.stringify({value:'private payload'}))
    }else if(request.url==='/rpc/stream'){
      response.setHeader('Content-Type','text/plain')
      response.write('first ')
      const timer=setTimeout(()=>response.end('second'),25)
      response.on('close',()=>clearTimeout(timer))
    }else{
      response.setHeader('Content-Type','text/html')
      response.end('<!doctype html><title>Fetch consumption control</title>')
    }
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin=`http://127.0.0.1:${server.address().port}`
  try{
    for(const browserType of [chromium,firefox,webkit]){
      const browser=await browserType.launch()
      try{
        const page=await browser.newPage()
        await page.addInitScript(installFetchConsumptionObservation,{previewOrigin:origin,pathPrefix:'/rpc/'})
        await page.goto(origin)
        const result=await page.evaluate(async()=>{
          const response=await fetch('/rpc/json')
          const unused=!response.bodyUsed
          const clone=response.clone()
          const original=await response.json(),cloned=await clone.json()
          const stream=await fetch('/rpc/stream'),reader=stream.body.getReader()
          const decoder=new TextDecoder()
          let text='',readCalls=0
          while(true){
            const chunk=await reader.read();readCalls++
            if(chunk.done)break
            text+=decoder.decode(chunk.value,{stream:true})
          }
          text+=decoder.decode();reader.releaseLock()
          return {unused,original,cloned,text,readCalls,observation:globalThis.__nativeFetchConsumptionObservation}
        })
        assert.equal(result.unused,true)
        assert.deepEqual(result.original,{value:'private payload'})
        assert.deepEqual(result.cloned,result.original)
        assert.equal(result.text,'first second')
        assert.equal(result.observation.limited,false)
        const rows=result.observation.rows
        assert.equal(rows.filter(row=>row.kind==='fetch-start').length,2)
        assert.equal(rows.filter(row=>row.kind==='json-fulfilled').length,2)
        assert.equal(rows.filter(row=>row.kind==='read-start').length,result.readCalls)
        assert.equal(rows.filter(row=>row.kind==='read-fulfilled').length,result.readCalls)
        assert.equal(rows.filter(row=>row.kind==='read-fulfilled'&&row.done).length,1)
        assert.equal(rows.filter(row=>row.kind==='cancel-start').length,0)
        assert.ok(!JSON.stringify(rows).includes('private payload'))
        console.log(JSON.stringify({browser:browserType.name(),version:browser.version(),consumptionControl:'passed',readCalls:result.readCalls}))
      }finally{await browser.close()}
    }
  }finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
})
