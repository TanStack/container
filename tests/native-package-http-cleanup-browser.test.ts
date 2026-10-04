import {expect,test} from 'vitest'
import {build} from 'esbuild'
import {chromium,firefox,webkit} from 'playwright'

test('failed package HTTP responses start cleanup without replacing their error in every engine',async()=>{
  const bundled=await build({stdin:{contents:`export {inspectBundledPackages} from './src/npm/install';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})
  for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage()
      const rows=await page.evaluate(async source=>{
        const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}))
        const originalFetch=globalThis.fetch
        try{
          const {inspectBundledPackages}=await new Function('url','return import(url)')(url)
          const rows=[]
          for(const mode of ['done','stalled','rejected']){
            let calls=0,reason
            const body=new ReadableStream({cancel(value){calls++;reason=value;
              if(mode==='stalled')return new Promise(()=>{})
              if(mode==='rejected')return Promise.reject(Error('cleanup failed'))
            }},{highWaterMark:0})
            globalThis.fetch=async()=>new Response(body,{status:503})
            let timer
            try{
              const error=await Promise.race([
                inspectBundledPackages('https://registry.npmjs.org/owned/-/owned-1.0.0.tgz','unused').catch(error=>error),
                new Promise(resolve=>{timer=setTimeout(()=>resolve(Error('Observation deadline')),1000)}),
              ])
              rows.push({mode,calls,sameReason:reason===error,message:error.message})
            }finally{clearTimeout(timer)}
          }
          return rows
        }finally{globalThis.fetch=originalFetch;URL.revokeObjectURL(url)}
      },bundled.outputFiles[0].text)
      expect(rows,engine.name()).toEqual(['done','stalled','rejected'].map(mode=>({mode,calls:1,sameReason:true,message:'Could not download /owned/-/owned-1.0.0.tgz (503)'})))
    }finally{await browser.close()}
  }
},30_000)
