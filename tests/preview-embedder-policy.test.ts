import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {it,expect} from 'vitest'

for(const mode of ['navigate','cors'])for(const status of [200,302,404,500,503])it(`service worker preserves HTTP ${status} ${mode} with the owner embedder policy`,async()=>{
  const listeners=new Map<string,(event:any)=>void>()
  const source=readFileSync('preview-host/sw.js','utf8')
  const body=status===302?null:'app response'
  const context={URL,Headers,Response,importScripts:()=>{},self:{location:{origin:'https://preview.invalid'},addEventListener:(name:string,fn:(event:any)=>void)=>listeners.set(name,fn)}}
  runInNewContext(source+`\nroute=async()=>new Response(${JSON.stringify(body)},{status:${status},headers:{'Cross-Origin-Embedder-Policy':'unsafe-none','x-app':'preserved'${status===302?",location:'/next'":''}}});`,context)
  let pending:Promise<Response>|undefined
  listeners.get('fetch')!({request:{url:'https://preview.invalid/',mode},respondWith(value:Promise<Response>){pending=value}})
  const response=await pending!
  expect(response.status).toBe(status)
  expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
  expect(response.headers.get('cross-origin-resource-policy')).toBe(mode==='navigate'?'cross-origin':null)
  expect(response.headers.get('x-app')).toBe('preserved')
  expect(await response.text()).toBe(body??'')
  if(status===302)expect(response.headers.get('location')).toBe('/next')
})
