import {beforeEach,expect,test,vi} from 'vitest'
vi.mock('../sandbox/guest-http.js',()=>({createServer:vi.fn()}))
import {vol} from '../src/vite-browser/node-fs'
import {staticResponse} from '../src/native/fetch-entry-server'

beforeEach(()=>{
  vol.reset()
  vol.fromJSON({'/app/dist/index.html':'root','/app/dist/docs/index.html':'docs',
    '/app/dist/assets/main.js':'console.log(42)','/app/private.html':'private'})
})

test('serves directory indexes and ordinary assets from the static root',async()=>{
  for(const [path,body] of [['/','root'],['/docs/','docs'],['/docs','docs'],['/assets/main.js','console.log(42)']]){
    const response=staticResponse(new Request('http://localhost'+path),'/app/dist')
    expect(response?.status).toBe(200)
    expect(await response?.text()).toBe(body)
  }
  const head=staticResponse(new Request('http://localhost/',{method:'HEAD'}),'/app/dist')
  expect(head?.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
  expect(head?.headers.get('Content-Length')).toBe('4')
  expect(await head?.text()).toBe('')
})

test('leaves missing paths and unsupported methods to the fetch handler',()=>{
  for(const path of ['/missing/','/%2e%2e%2fprivate.html','/%00','/assets%5cmain.js'])
    expect(staticResponse(new Request('http://localhost'+path),'/app/dist')).toBeUndefined()
  expect(staticResponse(new Request('http://localhost/',{method:'POST'}),'/app/dist')).toBeUndefined()
})
