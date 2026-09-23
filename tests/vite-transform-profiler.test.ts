import {test,expect} from 'vitest'
import {readFileSync} from 'node:fs'

const source=readFileSync('tests/fixtures/vite-transform-profiler.mjs','utf8')
  .replace("import {writeFileSync} from 'node:fs'",'')
  .replace('export function','function')
function setup(plugins:any[]){
  let snapshot:any[]=[]
  const factory=new Function('writeFileSync',source+';return transformProfiler')((_:string,json:string)=>{snapshot=JSON.parse(json)})
  factory().configResolved({plugins})
  return ()=>snapshot
}

test('transform profiler preserves hook metadata, receiver and results',async()=>{
  const receiver={environment:{name:'ssr'},marker:42},result={code:'ok'}
  const plugins:any[]=[{name:'sync',transform:{order:'pre',filter:{id:/module/},handler(this:any,code:string,id:string){expect(this).toBe(receiver);expect([code,id]).toEqual(['input','module']);return result}}},
    {name:'async',async transform(this:any){expect(this).toBe(receiver);return result}}]
  const snapshot=setup(plugins)
  expect(plugins[0].transform.order).toBe('pre')
  expect(plugins[0].transform.filter.id).toEqual(/module/)
  expect(plugins[0].transform.handler.call(receiver,'input','module')).toBe(result)
  expect(await plugins[1].transform.call(receiver,'input','module')).toBe(result)
  expect(snapshot()).toHaveLength(2)
  expect(snapshot().every(event=>event.environment==='ssr'&&event.end>=event.start)).toBe(true)
})

test('transform profiler propagates original errors and bounds recording',async()=>{
  const failure=new Error('original'),plugins:any[]=[{name:'throw',transform(){throw failure}},{name:'reject',transform(){return Promise.reject(failure)}},{name:'ok',transform(){return null}}]
  const snapshot=setup(plugins)
  expect(()=>plugins[0].transform('','x')).toThrow(failure)
  await expect(plugins[1].transform('','x')).rejects.toBe(failure)
  expect(snapshot().every(event=>event.error==='Error: original')).toBe(true)
  for(let i=0;i<1100;i++)expect(plugins[2].transform('','x')).toBeNull()
  expect(snapshot()).toHaveLength(1000)
})
