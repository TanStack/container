import {beforeEach,expect,test} from 'vitest'
import {vol} from '../src/vite-browser/node-fs'
import {volumeBuildLoader} from '../src/native/volume-build-loader'

beforeEach(()=>{vol.reset()})

test('loads HTML from the workspace for Vite HTML transforms',async()=>{
  const html='<script type="module" src="/main.js"></script>'
  vol.fromJSON({'/app/index.html':html})
  const load=volumeBuildLoader().load
  if(typeof load!=='function')throw Error('Expected build loader')
  expect(await load.call({} as never,'/app/index.html',{} as never)).toBe(html)
  expect(await load.call({} as never,'/app/index.html?url',{} as never)).toBeUndefined()
  expect(await load.call({} as never,'/app/missing.html',{} as never)).toBeUndefined()
})
