import {beforeEach,describe,expect,test} from 'vitest'
import {vol} from '../src/vite-browser/node-fs'
import {resolveVolumeImport,volumeResolver} from '../src/native/volume-resolver'

test('temporary modules load and resolve their relative imports',async()=>{
  vol.mkdirSync('/tmp/modules',{recursive:true})
  vol.writeFileSync('/tmp/modules/child.mjs','export default 42')
  expect(resolveVolumeImport('./child.mjs','/tmp/modules/main.mjs')).toBe('/tmp/modules/child.mjs')
  expect(resolveVolumeImport('../../../outside.mjs','/tmp/modules/main.mjs')).toBeUndefined()
  expect(await resolve('../../../outside.mjs','/tmp/modules/main.mjs')).toBeUndefined()
  expect(await resolve('/tmp/modules/child.mjs')).toBe('/tmp/modules/child.mjs')
  const load=volumeResolver().load
  if(typeof load!=='function')throw Error('Expected loader hook')
  expect(await load.call({} as never,'/tmp/modules/child.mjs',{} as never)).toBe('export default 42')
})
test('scratch modules resolve their own package exports and private imports',()=>{
  vol.fromJSON({'/tmp/pkg/package.json':JSON.stringify({type:'module',imports:{'#value':'./value.mjs'}}),
    '/tmp/pkg/value.mjs':'export default 42',
    '/tmp/pkg/node_modules/local/package.json':JSON.stringify({exports:{'.':{node:'./node.mjs',default:'./other.mjs'}}}),
    '/tmp/pkg/node_modules/local/node.mjs':'export default 43'})
  expect(resolveVolumeImport('#value','/tmp/pkg/entry.mjs')).toBe('/tmp/pkg/value.mjs')
  expect(resolveVolumeImport('local','/tmp/pkg/entry.mjs')).toBe('/tmp/pkg/node_modules/local/node.mjs')
})

test('an explicitly blocked condition does not fall through to a default target',()=>{
  vol.fromJSON({'/tmp/blocked/package.json':JSON.stringify({imports:{'#blocked':{node:null,default:'./fallback.mjs'}}}),
    '/tmp/blocked/fallback.mjs':'export default 42',
    '/tmp/blocked/node_modules/blocked/package.json':JSON.stringify({exports:{node:null,default:'./fallback.mjs'}}),
    '/tmp/blocked/node_modules/blocked/fallback.mjs':'export default 43'})
  expect(resolveVolumeImport('#blocked','/tmp/blocked/main.mjs')).toBeUndefined()
  expect(resolveVolumeImport('blocked','/tmp/blocked/main.mjs')).toBeUndefined()
})

test('private package imports can point to supported Node builtins',()=>{
  vol.fromJSON({'/tmp/builtin/package.json':JSON.stringify({imports:{'#path':'path','#fs':'fs','#invalid':'node:path'}})})
  expect(resolveVolumeImport('#path','/tmp/builtin/main.mjs')).toBe('node:path')
  expect(resolveVolumeImport('#fs','/tmp/builtin/main.mjs')).toBe('node:fs')
  expect(()=>resolveVolumeImport('#invalid','/tmp/builtin/main.mjs')).toThrow('Invalid package import target')
})

const resolve=(id:string,importer='/app/main.js')=>{
  const hook=volumeResolver().resolveId
  if(typeof hook!=='function')throw Error('Expected resolver hook')
  return hook.call({} as never,id,importer,{} as never)
}

describe('native volume resolver',()=>{
  test('resolves a bare build entry against the workspace without treating imports as files',async()=>{
    vol.fromJSON({'/app/index.html':'<h1>Entry</h1>'})
    const hook=volumeResolver().resolveId
    if(typeof hook!=='function')throw Error('Expected resolver hook')
    expect(await hook.call({} as never,'index.html',undefined,{isEntry:true} as never)).toBe('/app/index.html')
    expect(await hook.call({} as never,'index.html','/app/main.js',{isEntry:false} as never)).toBeUndefined()
  })
  beforeEach(()=>{
    vol.reset()
    vol.fromJSON({
      '/app/main.js':'import "react"',
      '/app/tsconfig.json':'{"compilerOptions":{"paths":{"~/*":["./src/*"]}}}',
      '/app/src/styles/app.css':'body{}',
      '/app/src/pages/index.astro':'<h1>Fixture</h1>',
      '/app/lib/message.ts':'export const message=1',
      '/app/node_modules/react/package.json':JSON.stringify({exports:{'.':{browser:'./browser.js',default:'./index.js'},'./jsx-runtime':'./jsx-runtime.js'}}),
      '/app/node_modules/react/browser.js':'export default 1',
      '/app/node_modules/react/index.js':'module.exports=1',
      '/app/node_modules/react/jsx-runtime.js':'export const jsx=1',
      '/app/node_modules/picomatch/package.json':JSON.stringify({main:'index.js'}),
      '/app/node_modules/picomatch/index.js':'module.exports=()=>true',
      '/app/node_modules/mapped/package.json':JSON.stringify({main:'index.js',browser:{'./index.js':'./browser.js'}}),
      '/app/node_modules/mapped/index.js':'module.exports=1',
      '/app/node_modules/mapped/browser.js':'export default 1',
      '/app/node_modules/scoped/package.json':JSON.stringify({imports:{'#flag':{browser:'./browser.js',default:'./default.js'}}}),
      '/app/node_modules/scoped/browser.js':'export default true',
      '/app/node_modules/scoped/default.js':'export default false',
      '/app/node_modules/dual/package.json':JSON.stringify({exports:{'.':{browser:'./client.js',node:'./server.js'}}}),
      '/app/node_modules/dual/client.js':'export const target="client"',
      '/app/node_modules/dual/server.js':'export const target="server"',
      '/app/node_modules/framework/package.json':JSON.stringify({exports:{'.':{solid:'./source.jsx',import:'./precompiled.js'}}}),
      '/app/node_modules/framework/source.jsx':'export const target="source"',
      '/app/node_modules/framework/precompiled.js':'export const target="precompiled"',
      '/app/node_modules/framework/runtime/navigation/index.js':'export const navigate=()=>{}',
    })
  })

  test('resolves root, relative, and browser package export paths',async()=>{
    expect(await resolve('/main.js')).toBe('/app/main.js')
    expect(await resolve('./lib/message','/app/main.js')).toBe('/app/lib/message.ts')
    expect(await resolve('react')).toBe('/app/node_modules/react/browser.js')
    expect(await resolve('react/jsx-runtime')).toBe('/app/node_modules/react/jsx-runtime.js')
    expect(await resolve('picomatch')).toBe('/app/node_modules/picomatch/index.js')
    expect(await resolve('node_modules/picomatch/index.js')).toBe('/app/node_modules/picomatch/index.js')
    expect(await resolve('mapped')).toBe('/app/node_modules/mapped/browser.js')
    expect(await resolve('#flag','/app/node_modules/scoped/index.js')).toBe('/app/node_modules/scoped/browser.js')
  })

  test('does not escape the workspace or resolve missing exports',async()=>{
    expect(await resolve('/../../outside.js')).toBeUndefined()
    expect(await resolve('react/private')).toBeUndefined()
    expect(await resolve('/@vite/client')).toBeUndefined()
  })

  test('preserves plugin query parameters on installed and workspace modules',async()=>{
    expect(await resolve('/app/lib/message.ts?server-fn-module-lookup'))
      .toBe('/app/lib/message.ts?server-fn-module-lookup')
    expect(await resolve('react/jsx-runtime?probe=1'))
      .toBe('/app/node_modules/react/jsx-runtime.js?probe=1')
  })

  test('selects server exports for the server environment',async()=>{
    const hook=volumeResolver().resolveId
    if(typeof hook!=='function')throw Error('Expected resolver hook')
    const context={environment:{config:{consumer:'server'}}}
    expect(await resolve('dual')).toBe('/app/node_modules/dual/client.js')
    expect(await hook.call(context as never,'dual','/app/main.js',{} as never))
      .toBe('/app/node_modules/dual/server.js')
    expect(await hook.call(context as never,'#flag','/app/node_modules/scoped/index.js',{} as never))
      .toBe('/app/node_modules/scoped/default.js')
  })

  test('resolves import.meta.resolve with server import conditions',()=>{
    expect(resolveVolumeImport('dual','/app/main.js'))
      .toBe('/app/node_modules/dual/server.js')
    expect(resolveVolumeImport('./lib/message','/app/main.js'))
      .toBe('/app/lib/message.ts')
    expect(resolveVolumeImport('react/private','/app/main.js')).toBeUndefined()
    expect(resolveVolumeImport('framework','/app/main.js','server',['solid']))
      .toBe('/app/node_modules/framework/source.jsx')
  })

  test('honors conditions installed by framework plugins',async()=>{
    const hook=volumeResolver().resolveId
    if(typeof hook!=='function')throw Error('Expected resolver hook')
    const context={environment:{config:{consumer:'server',resolve:{conditions:['solid','node']}}}}
    expect(await hook.call(context as never,'framework','/app/main.js',{} as never))
      .toBe('/app/node_modules/framework/source.jsx')
  })

  test('resolves installed package directory index modules',async()=>{
    expect(await resolve('/app/node_modules/framework/runtime/navigation'))
      .toBe('/app/node_modules/framework/runtime/navigation/index.js')
  })

  test('resolves configured TypeScript path mappings from the workspace volume',async()=>{
    const hook=volumeResolver().resolveId
    if(typeof hook!=='function')throw Error('Expected resolver hook')
    const context={environment:{config:{consumer:'server',resolve:{tsconfigPaths:true}}}}
    expect(await hook.call(context as never,'~/styles/app.css?url','/app/src/main.tsx',{} as never))
      .toBe('/app/src/styles/app.css?url')
  })

  test('resolves imports in plugin virtual modules from the project root',async()=>{
    expect(await resolve('react','/@plugin-runtime'))
      .toBe('/app/node_modules/react/browser.js')
    expect(await resolve('src/pages/index.astro','\0virtual:page'))
      .toBe('/app/src/pages/index.astro')
    expect(await resolve('/src/pages/index.astro','\0virtual:page'))
      .toBe('/app/src/pages/index.astro')
  })

  test('loads framework source from the browser volume for plugin transforms',()=>{
    const hook=volumeResolver().load
    if(typeof hook!=='function')throw Error('Expected load hook')
    expect(hook.call({} as never,'/app/src/pages/index.astro',{} as never))
      .toBe('<h1>Fixture</h1>')
  })

  test('falls back from Vite internal resolution to workspace packages',async()=>{
    const hook=volumeResolver().configResolved
    if(typeof hook!=='function')throw Error('Expected configResolved hook')
    const config={createResolver:(_options?:unknown)=>async(id:string,_importer?:string,_aliasOnly?:boolean,_ssr?:boolean)=>
      id==='aliased'?'/app/lib/message.ts':undefined}
    await hook.call({} as never,config as never)
    const internal=config.createResolver()
    expect(await internal('aliased')).toBe('/app/lib/message.ts')
    expect(await internal('react')).toBe('/app/node_modules/react/browser.js')
    expect(await internal('dual','/app/main.js',false,true)).toBe('/app/node_modules/dual/server.js')
    expect(await internal('react',undefined,true)).toBeUndefined()
  })

  test('lets a virtual-module plugin claim package-private imports first',async()=>{
    const hook=volumeResolver().resolveId
    if(typeof hook!=='function')throw Error('Expected resolver hook')
    const context={resolve:async()=>({id:'\0virtual:server-function-resolver'})}
    expect(await hook.call(context as never,'#resolver','/app/node_modules/scoped/index.js',{} as never))
      .toEqual({id:'\0virtual:server-function-resolver'})
  })
  test('canonicalizes a server private builtin claimed by Vite',async()=>{
    const hook=volumeResolver().resolveId
    if(typeof hook!=='function')throw Error('Expected resolver hook')
    const context={environment:{config:{consumer:'server'}},resolve:async()=>({id:'path'})}
    expect(await hook.call(context as never,'#path','/tmp/pkg/main.mjs',{} as never))
      .toEqual({id:'node:path',external:true})
  })
})
