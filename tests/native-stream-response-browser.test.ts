import {expect,test} from 'vitest'
import {build} from 'esbuild'
import {chromium,firefox,webkit} from 'playwright'
import {probeStreamResponse} from './fixtures/native-stream-response.mjs'
import {runInNewContext} from 'node:vm'

test('stream response body methods match actual Node in every desktop engine',async()=>{
  const expected=await probeStreamResponse(Response,runInNewContext('new Uint8Array([1,2,255])'))
  const bundled=await build({stdin:{contents:`export {StreamResponse} from './src/sandbox/stream-response';export {probeStreamResponse} from './tests/fixtures/native-stream-response.mjs';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})
  for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage()
      const actual=await page.evaluate(async source=>{
        const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}))
        try{
          const {StreamResponse,probeStreamResponse}=await new Function('url','return import(url)')(url)
          const frame=document.createElement('iframe');document.body.append(frame)
          try{return await probeStreamResponse(StreamResponse,new frame.contentWindow.Uint8Array([1,2,255]))}
          finally{frame.remove()}
        }finally{URL.revokeObjectURL(url)}
      },bundled.outputFiles[0].text)
      expect(actual,engine.name()).toEqual(expected)
    }finally{await browser.close()}
  }
},30_000)
