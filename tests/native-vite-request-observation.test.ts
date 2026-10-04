import {expect, test, vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {observeViteRequests} from '../src/native/vite-request-observation'

test('optional callback stages record bounded entry and outcome metadata and restore the hook',()=>{
  const key=Symbol.for('web-container:vite-private-callback'),descriptor=Object.getOwnPropertyDescriptor(globalThis,key)
  const rows:any[]=[],observation=observeViteRequests({environments:{}},row=>rows.push(row),{callbackStages:true,maxPending:1})
  const observe=Reflect.get(globalThis,key)
  const finish=observe('#target?token=secret','/app/main.js?token=secret','ssr')
  observation.snapshot('pending')
  expect(rows.at(-1)).toMatchObject({callbacksStarted:1,callbacksSettled:0,
    stages:[{method:'resolveSubpathImports',specifier:'#target',importer:'/app/main.js'}]})
  finish('returned');finish('threw')
  for(let i=0;i<66;i++)observe('#target','/app/main.js','ssr')(i%2?'threw':'returned')
  observation.snapshot('finished')
  expect(rows.at(-1)).toMatchObject({callbacksStarted:67,callbacksSettled:67,callbackTailDropped:3,stages:[]})
  expect(rows.at(-1).callbackTail).toHaveLength(64)
  expect(JSON.stringify(rows)).not.toContain('secret')
  observation.dispose()
  expect(Object.getOwnPropertyDescriptor(globalThis,key)).toEqual(descriptor)
})

test('callback hooks are absent by default and disposal does not overwrite a later hook',()=>{
  const key=Symbol.for('web-container:vite-private-callback'),descriptor=Object.getOwnPropertyDescriptor(globalThis,key)
  const plain=observeViteRequests({environments:{}},()=>{},{innerStages:true})
  expect(Object.getOwnPropertyDescriptor(globalThis,key)).toEqual(descriptor);plain.dispose()
  const observation=observeViteRequests({environments:{}},()=>{},{callbackStages:true})
  const later=()=>{}
  Object.defineProperty(globalThis,key,{value:later,configurable:true})
  observation.dispose();expect(Reflect.get(globalThis,key)).toBe(later)
  if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)
})

test('Vite observation preserves transform receivers, arguments and original promises', async () => {
  const result = Promise.resolve({code:'not observed'}), rows:any[] = []
  const original = vi.fn(function(this:unknown,..._args:unknown[]){expect(this).toBe(environment);return result})
  const environment = {transformRequest:original}, options={html:true}
  const observation=observeViteRequests({environments:{client:environment}},row=>rows.push(row))
  expect(environment.transformRequest('/module.js?token=secret',options)).toBe(result)
  await result
  expect(original).toHaveBeenCalledWith('/module.js?token=secret',options)
  expect(rows.map(row=>row.kind)).toEqual(['transform-start','transform-end'])
  expect(rows[0].pathname).toBe('/module.js')
  expect(JSON.stringify(rows)).not.toContain('secret')
  expect(JSON.stringify(rows)).not.toContain('not observed')
  observation.dispose();expect(environment.transformRequest).toBe(original)
})
test('Vite HTTP metadata observes handler arrival and finishes without accessing body or headers', () => {
  const server=new EventEmitter(),res=Object.assign(new EventEmitter(),{statusCode:200}),rows:any[]=[]
  const req={method:'GET',url:'https://name:secret@host.invalid/a.js?key=secret#fragment',
    get headers(){throw Error('Do not read headers')},get body(){throw Error('Do not read body')}}
  const observation=observeViteRequests({httpServer:server,environments:{}},row=>rows.push(row))
  server.on('request',()=>expect(rows.at(-1).kind).toBe('http-start'))
  server.emit('request',req,res);res.emit('finish');res.emit('close')
  expect(rows.map(row=>row.kind)).toEqual(['http-start','http-finish'])
  expect(rows[0].pathname).toBe('/a.js')
  expect(JSON.stringify(rows)).not.toContain('secret')
  observation.snapshot('after finish');expect(rows.at(-1).http).toEqual([])
  observation.dispose();expect(res.listenerCount('close')).toBe(0)
})
test('pending HTTP and transform calls survive event limits and snapshots expose the limit', () => {
  const server=new EventEmitter(),res=new EventEmitter(),rows:any[]=[]
  const environment={transformRequest:()=>new Promise(()=>{})}
  const observation=observeViteRequests({httpServer:server,environments:{client:environment}},row=>rows.push(row),{maxEvents:1,maxPending:1})
  server.emit('request',{method:'GET',url:'/waiting'},res)
  environment.transformRequest();environment.transformRequest()
  observation.snapshot('pending')
  expect(rows.at(-1)).toMatchObject({dropped:2,pendingDropped:1,http:[{pathname:'/waiting'}],transforms:[{environment:'client'}]})
  observation.dispose();expect(server.listenerCount('request')).toBe(0)
  expect(res.listenerCount('finish')).toBe(0)
})
test('a close emitted inside an earlier finish listener records one terminal event', () => {
  const server=new EventEmitter(),res=new EventEmitter(),rows:any[]=[]
  // The guest HTTP server installs this listener before emitting request.
  res.once('finish',()=>res.emit('close'))
  const observation=observeViteRequests({httpServer:server,environments:{}},row=>rows.push(row))
  server.emit('request',{method:'GET',url:'/module.js'},res)
  res.emit('finish')
  expect(rows.map(row=>row.kind)).toEqual(['http-start','http-close'])
  observation.snapshot('after nested close');expect(rows.at(-1).http).toEqual([])
  expect(res.listenerCount('finish')).toBe(0)
  expect(res.listenerCount('close')).toBe(0)
  observation.dispose()
})
test('recording failures do not replace synchronous throws or rejected original transforms', async () => {
  const error=Error('original'),result=Promise.reject(error)
  const environment={transformRequest:()=>result}
  const observation=observeViteRequests({environments:{client:environment}},()=>{throw Error('observer')})
  expect(environment.transformRequest()).toBe(result)
  await expect(result).rejects.toBe(error)
  observation.dispose()
  const sync={transformRequest:()=>{throw error}}
  const other=observeViteRequests({environments:{client:sync}},()=>{throw Error('observer')})
  expect(()=>sync.transformRequest()).toThrow(error)
  other.dispose()
})
test('disposal restores inherited methods and does not overwrite a later replacement', () => {
  const original=()=>Promise.resolve(null),prototype={transformRequest:original}
  const environment=Object.create(prototype)
  const observation=observeViteRequests({environments:{client:environment}},()=>{})
  expect(Object.hasOwn(environment,'transformRequest')).toBe(true)
  observation.dispose();observation.dispose()
  expect(Object.hasOwn(environment,'transformRequest')).toBe(false)
  const other=observeViteRequests({environments:{client:environment}},()=>{})
  const replacement=()=>Promise.resolve(null);environment.transformRequest=replacement
  other.dispose();expect(environment.transformRequest).toBe(replacement)
})
test('invalid limits fail before changing a server', () => {
  const original=()=>Promise.resolve(null),environment={transformRequest:original}
  expect(()=>observeViteRequests({environments:{client:environment}},()=>{},{maxEvents:0})).toThrow('Invalid Vite observation limits')
  expect(environment.transformRequest).toBe(original)
})

test('inner stages preserve promises and arguments without recording transform source or results', async () => {
  const rows:any[]=[], result=Promise.resolve({code:'private-result'})
  let resolveLoad!:(value:unknown)=>void
  const loadPromise=new Promise(resolve=>{resolveLoad=resolve})
  const container={
    resolveId:vi.fn(function(this:unknown,..._args:unknown[]){expect(this).toBe(container);return result}),
    load:vi.fn(()=>loadPromise),
    transform:vi.fn(function(this:unknown,..._args:unknown[]){expect(this).toBe(container);return result}),
  }
  const original={...container},environment={transformRequest:()=>result,pluginContainer:container}
  const observation=observeViteRequests({environments:{ssr:environment}},row=>rows.push(row),{innerStages:true})
  expect(container.resolveId('/a.js?secret=value')).toBe(result)
  expect(container.load('/a.js?secret=value')).toBe(loadPromise)
  expect(container.transform('private-source','/a.js?secret=value')).toBe(result)
  expect(original.resolveId).toHaveBeenCalledWith('/a.js?secret=value')
  expect(original.transform).toHaveBeenCalledWith('private-source','/a.js?secret=value')
  await result
  observation.snapshot('waiting')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({stagesStarted:3,stagesSettled:2,stages:[{method:'load',environment:'ssr',pathname:'/a.js'}]})
  expect(JSON.stringify(rows)).not.toMatch(/private-source|private-result|secret|value/)
  resolveLoad(null);await loadPromise
  observation.snapshot('complete')
  expect(rows[1]).toMatchObject({stagesStarted:3,stagesSettled:3,stages:[]})
  observation.dispose()
})

test('inner stages restore inherited methods and keep original synchronous failures', () => {
  const error=Error('original'),rows:any[]=[]
  const prototype={load:()=>{throw error},resolveId:()=>null}
  const container=Object.create(prototype),environment={transformRequest:()=>Promise.resolve(null),pluginContainer:container}
  const disabled=observeViteRequests({environments:{ssr:environment}},()=>{})
  expect(Object.hasOwn(container,'load')).toBe(false);disabled.dispose()
  const observation=observeViteRequests({environments:{ssr:environment}},row=>rows.push(row),{innerStages:true})
  expect(()=>container.load('/bad')).toThrow(error)
  expect(container.resolveId('/missing')).toBe(null)
  observation.snapshot('settled')
  expect(rows[0]).toMatchObject({stagesStarted:2,stagesSettled:2,stages:[]})
  observation.dispose()
  expect(Object.hasOwn(container,'load')).toBe(false)
  expect(container.load).toBe(prototype.load)
})

test('inner pending caps and rejection cleanup do not change an original rejected promise', async () => {
  const rows:any[]=[],error=Error('original'),result=Promise.reject(error)
  const graph={getModuleByUrl:()=>new Promise(()=>{}),_ensureEntryFromUrl:()=>result}
  const observation=observeViteRequests({environments:{ssr:{transformRequest:()=>result,moduleGraph:graph}}},
    row=>rows.push(row),{innerStages:true,maxPending:1})
  graph.getModuleByUrl();graph.getModuleByUrl()
  expect(graph._ensureEntryFromUrl()).toBe(result)
  await expect(result).rejects.toBe(error)
  observation.snapshot('bounded')
  expect(rows[0]).toMatchObject({pendingDropped:2,stagesStarted:3,stagesSettled:1,stages:[{method:'getModuleByUrl'}]})
  observation.dispose()
})

test('inner-stage observation works through a real Vite plugin container and module graph', async () => {
  const {createServer}=await import('vite')
  const server=await createServer({configFile:false,envFile:false,logLevel:'silent',
    server:{middlewareMode:true,watch:null,hmr:false,preTransformRequests:false},
    optimizeDeps:{noDiscovery:true,include:[]},
    plugins:[{name:'observation-control',resolveId(id){if(id==='/observation-control.js')return '\0observation-control'},
      load(id){if(id==='\0observation-control')return 'export const answer = 42'} }]})
  const rows:any[]=[],original=server.environments.client!.transformRequest
  const observation=observeViteRequests(server,row=>rows.push(row),{innerStages:true})
  try {
    const result=await server.environments.client!.transformRequest('/observation-control.js')
    expect(result?.code).toContain('answer = 42')
    observation.snapshot('real Vite settled')
    const snapshot=rows.at(-1)
    expect(snapshot.stagesStarted).toBeGreaterThan(0)
    expect(snapshot.stagesSettled).toBe(snapshot.stagesStarted)
    expect(snapshot.stages).toEqual([])
    expect(snapshot.transforms).toEqual([])
    expect(snapshot.pendingDropped).toBe(0)
  } finally {
    observation.dispose()
    expect(server.environments.client!.transformRequest).toBe(original)
    await server.close()
  }
})

test('resolver hooks preserve receivers, package import names and object hook metadata', async () => {
  const rows:any[]=[],result=Promise.resolve(null)
  const original=vi.fn(function(this:unknown,..._args:unknown[]){expect(this).toBe(context);return result})
  const filter={id:/^#/},hook={order:'pre',filter,handler:original}
  Object.defineProperty(hook,'untouched',{get(){throw Error('Do not read hook metadata')},enumerable:false})
  const plugin={name:'generic-resolver',resolveId:hook},context={environment:{name:'ssr'}}
  const environment={transformRequest:()=>result,pluginContainer:{plugins:[plugin]}}
  const observation=observeViteRequests({environments:{client:environment,ssr:environment}},row=>rows.push(row),{innerStages:true})
  const wrapped=plugin.resolveId
  expect(wrapped.order).toBe('pre');expect(wrapped.filter).toBe(filter)
  expect(Object.getOwnPropertyDescriptor(wrapped,'untouched')).toEqual(Object.getOwnPropertyDescriptor(hook,'untouched'))
  expect(wrapped.handler.call(context,'#private-entry?secret=value','/app/index.js?secret=value',{skipSelf:true})).toBe(result)
  observation.snapshot('pending resolver')
  expect(rows[0]).toMatchObject({stagesStarted:1,stages:[{environment:'ssr',method:'plugin.resolveId',
    plugin:'generic-resolver',specifier:'#private-entry',importer:'/app/index.js'}]})
  expect(JSON.stringify(rows)).not.toContain('secret')
  expect(original).toHaveBeenCalledWith('#private-entry?secret=value','/app/index.js?secret=value',{skipSelf:true})
  await result
  observation.snapshot('resolver settled');expect(rows[1]).toMatchObject({stagesStarted:1,stagesSettled:1,stages:[]})
  observation.dispose();expect(plugin.resolveId).toBe(hook)
})

test('inline module identifiers never record their embedded source', async () => {
  const rows:any[]=[],result=Promise.resolve(null),environment={transformRequest:()=>result}
  const observation=observeViteRequests({environments:{ssr:environment}},row=>rows.push(row))
  environment.transformRequest('data:text/javascript,export const privateSource = 42')
  await result
  expect(rows[0].pathname).toBe('<inline module>')
  expect(JSON.stringify(rows)).not.toContain('privateSource')
  observation.dispose()
})
