import {describe,expect,test} from 'vitest'
import {installBrowserModuleFetch} from '../src/native/runnable-loader'

describe('browser module fetch',()=>{
  test('closes activity after rejection and preserves the original error',async()=>{
    let reject!:(reason:unknown)=>void
    let fetched!:()=>void
    const entered=new Promise<void>(done=>{fetched=done})
    const pending=new Promise<unknown>((_,fail)=>{reject=fail})
    const events:string[]=[]
    const environment={pluginContainer:{resolveId:async()=>null},fetchModule:async(_id:string)=>{fetched();return pending}}
    installBrowserModuleFetch(environment,phase=>events.push(phase))
    const result=environment.fetchModule('/app/failed.js')
    const reason=Error('module transform failed')
    const assertion=expect(result).rejects.toBe(reason)
    await entered
    expect(events).toEqual(['start'])
    reject(reason)
    await assertion
    expect(events).toEqual(['start','end'])
  })
  test.each([false,true])('keeps activity open until the fetch settles, resolved alias: %s',async(alias)=>{
    let resolve!:(value:unknown)=>void
    const pending=new Promise<unknown>(done=>{resolve=done})
    const events:string[]=[]
    const environment={pluginContainer:{resolveId:async()=>({id:'/app/module.js'})},fetchModule:async()=>pending}
    installBrowserModuleFetch(environment,phase=>events.push(phase))
    const result=environment.fetchModule(alias?'fixture':'/app/module.js', '/app/main.js')
    await Promise.resolve();await Promise.resolve();await Promise.resolve()
    expect(events).toEqual(['start'])
    resolve({code:'done'})
    expect(await result).toEqual({code:'done'})
    expect(events).toEqual(['start','end'])
  })
  test('externalizes supported builtins after resolving private scratch aliases',async()=>{
    const fetched:string[]=[]
    const environment={pluginContainer:{resolveId:async(id:string)=>id==='#path'?{id:'node:path'}:null},
      fetchModule:async(id:string)=>{fetched.push(id);return {code:id}}}
    installBrowserModuleFetch(environment)
    expect(await environment.fetchModule('#path','/tmp/modules/main.mjs')).toEqual({externalize:'node:path',type:'builtin'})
    expect(await environment.fetchModule('node:fs','/tmp/modules/main.mjs')).toEqual({externalize:'node:fs',type:'builtin'})
    expect(await environment.fetchModule('/@id/node:path','/tmp/modules/main.mjs')).toEqual({externalize:'node:path',type:'builtin'})
    expect(fetched).toEqual([])
    expect(await environment.fetchModule('missing','/tmp/modules/main.mjs')).toEqual({code:'missing'})
  })
  test('routes installed imports through the worker transform pipeline',async()=>{
    const fetched:string[]=[]
    const environment={
      pluginContainer:{resolveId:async(id:string)=>id==='fixture'?{id:'/app/node_modules/fixture/index.js'}:null},
      fetchModule:async(id:string,_importer?:string)=>{fetched.push(id);return {code:id}},
    }
    installBrowserModuleFetch(environment)
    expect(await environment.fetchModule('fixture','/app/vite.config.ts')).toEqual({code:'/app/node_modules/fixture/index.js'})
    expect(fetched).toEqual(['/app/node_modules/fixture/index.js'])
    expect(await environment.fetchModule('missing','/app/vite.config.ts')).toEqual({code:'missing'})
  })

  test('maps only public Rolldown entry points to the browser provider',async()=>{
    const environment={
      pluginContainer:{resolveId:async()=>null},
      fetchModule:async(id:string)=>({code:id}),
    }
    installBrowserModuleFetch(environment)
    expect(await environment.fetchModule('/node_modules/rolldown/dist/parse-ast-index.mjs'))
      .toEqual({externalize:'browser-native:rolldown/parseAst',type:'builtin'})
    expect(await environment.fetchModule('/node_modules/rolldown/dist/shared/parse.mjs'))
      .toEqual({code:'/node_modules/rolldown/dist/shared/parse.mjs'})
  })

  test('routes the published native-addon CSS entry to its browser provider',async()=>{
    const environment={
      pluginContainer:{resolveId:async(id:string)=>id==='lightningcss'?{id:'/app/node_modules/lightningcss/node/index.js'}:null},
      fetchModule:async(id:string)=>({code:id}),
    }
    installBrowserModuleFetch(environment)
    expect(await environment.fetchModule('lightningcss'))
      .toEqual({externalize:'browser-native:lightningcss:%2Fapp%2Fnode_modules%2Flightningcss',type:'builtin'})
    expect(await environment.fetchModule('/app/node_modules/lightningcss/node/index.js'))
      .toEqual({externalize:'browser-native:lightningcss:%2Fapp%2Fnode_modules%2Flightningcss',type:'builtin'})
    expect(await environment.fetchModule('/app/node_modules/not-lightningcss/node/index.js'))
      .toEqual({code:'/app/node_modules/not-lightningcss/node/index.js'})
  })

  test('routes formatter imports to the browser entry with syntax plugins',async()=>{
    const environment={
      pluginContainer:{resolveId:async()=>null},
      fetchModule:async(id:string)=>({code:id}),
    }
    installBrowserModuleFetch(environment)
    expect(await environment.fetchModule('prettier'))
      .toEqual({externalize:'browser-native:prettier',type:'builtin'})
    expect(await environment.fetchModule('/app/node_modules/prettier/index.mjs'))
      .toEqual({externalize:'browser-native:prettier:%2Fapp%2Fnode_modules%2Fprettier',type:'builtin'})
    expect(await environment.fetchModule('/app/node_modules/prettier/standalone.mjs'))
      .toEqual({code:'/app/node_modules/prettier/standalone.mjs'})
    expect(await environment.fetchModule('/tmp/project/node_modules/prettier/index.mjs'))
      .toEqual({externalize:'browser-native:prettier:%2Ftmp%2Fproject%2Fnode_modules%2Fprettier',type:'builtin'})
    expect(await environment.fetchModule('/@fs/app/node_modules/prettier/index.mjs'))
      .toEqual({externalize:'browser-native:prettier:%2Fapp%2Fnode_modules%2Fprettier',type:'builtin'})
    expect(await environment.fetchModule('/app/node_modules/prettier/plugins/estree.mjs'))
      .toEqual({code:'/app/node_modules/prettier/plugins/estree.mjs'})
  })

  test('routes the installed Vite package to the identical worker toolchain',async()=>{
    const environment={
      pluginContainer:{resolveId:async()=>null},
      fetchModule:async(id:string)=>({code:id}),
    }
    installBrowserModuleFetch(environment)
    expect(await environment.fetchModule('vite'))
      .toEqual({externalize:'browser-native:vite',type:'builtin'})
    expect(await environment.fetchModule('/app/node_modules/vite/dist/node/index.js'))
      .toEqual({externalize:'browser-native:vite',type:'builtin'})
  })
})
