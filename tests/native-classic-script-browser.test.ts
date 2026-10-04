import {expect,test} from 'vitest'
import {Script} from 'node:vm'
import {chromium,firefox,webkit} from 'playwright'
import {createServer} from 'node:http'
import {vmCompletionControlSources,nestedVMCompletionSources} from './fixtures/native-vm-completions.mjs'
import {compileClassicScriptCompletion,createClassicScriptCompletionChannel} from '../src/native/classic-script-completion'

test('classic worker script completions match Node in all desktop engines',async()=>{
  const encode=(value:unknown)=>JSON.stringify({kind:typeof value,value},(_key,item)=>typeof item==='bigint'?item.toString():item)
  const rows=[...vmCompletionControlSources,...nestedVMCompletionSources,'"\\u0061"','"a\\nb"','"\\x61"','"\\u{1F600}"','"use strict";"\\u0061"',
    'try{42}finally{try{7}finally{9}}','try{42}finally{while(false)7}',
    '"a"// final comment','42// final comment','if(true)(1,2)// comment',
  ].map(source=>({source,
    code:compileClassicScriptCompletion(source,'/app/completion.js','completion-channel').code!,
    expected:encode(new Script(source).runInNewContext()),
  }))
  const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html>')})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    for(const engine of [chromium,firefox,webkit]){
      const browser=await engine.launch()
      try{
        const page=await browser.newPage()
        await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`)
        const actual=await page.evaluate(async({rows,channelSource})=>{
          const results=[]
          for(const row of rows){
            const workerSource=`(()=>{const channel=(${channelSource})();Object.defineProperty(self,'completion-channel',{value:channel});
              const url=URL.createObjectURL(new Blob([${JSON.stringify(row.code)}],{type:'text/javascript'}));
              try{importScripts(url);postMessage(JSON.stringify({kind:typeof channel.value,value:channel.value},(_key,item)=>typeof item==='bigint'?item.toString():item))}
              catch(error){postMessage(JSON.stringify({error:String(error)}))}finally{URL.revokeObjectURL(url)}})()`
            const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}))
            const worker=new Worker(url)
            try{
              results.push(await new Promise<string>((resolve,reject)=>{
                const timer=setTimeout(()=>reject(Error('Completion worker timed out')),5000)
                worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)}
                worker.onerror=event=>{clearTimeout(timer);reject(Error(event.message))}
              }))
            }finally{worker.terminate();URL.revokeObjectURL(url)}
          }
          return results
        },{rows,channelSource:createClassicScriptCompletionChannel.toString()})
        for(let index=0;index<rows.length;index++)
          expect(actual[index],`${engine.name()}: ${rows[index].source}`).toBe(rows[index].expected)
      }finally{await browser.close()}
    }
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
},60_000)
