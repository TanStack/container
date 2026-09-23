import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,readFileSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {files,cases,descriptor,updateCase} from './resolve-cases.mjs'
import {resolveSubpathImports} from './resolve-callback.mjs'
const here=dirname(fileURLToPath(import.meta.url))
const modules=resolve(here,'../../../fixtures/start-vite8-wasm/node_modules')
for(const [name,version]of [['vite','8.3.0'],['rolldown','1.2.9']])assert.equal(JSON.parse(readFileSync(join(modules,name,'package.json'),'utf8')).version,version)
const {t:loadBinding}=await import(pathToFileURL(join(modules,'rolldown/dist/shared/binding-BbrDfv1x.mjs')))
const binding=loadBinding(),Native=binding.BindingCallableBuiltinPlugin,captured=[],trace=[]
function shape(value){
  if(typeof value==='function')return {type:'callback'}
  if(value instanceof RegExp)return {type:'RegExp',source:value.source,flags:value.flags}
  if(Array.isArray(value))return value.map(shape)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,shape(item)]))
  return value
}
// Test-only instrumentation, delegate the exact descriptor and native constructor.
binding.BindingCallableBuiltinPlugin=class extends Native{
  constructor(descriptor){
    const original=descriptor
    if(descriptor.__name==='builtin:vite-resolve'){
      const options={...descriptor.options}
      for(const [name,callback]of Object.entries(options))if(typeof callback==='function')options[name]=(...args)=>{
        const value=callback(...args)
        trace.push({environment:options.environmentName,name,args,value:shape(value)})
        return value
      }
      descriptor={...descriptor,options}
    }
    super(descriptor)
    if(descriptor.__name==='builtin:vite-resolve')captured.push({descriptor:original,plugin:this})
  }
}
const project=realpathSync(mkdtempSync(join(tmpdir(),'rolldown-resolver-reference-')))
function file(name,source){const path=join(project,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,source)}
for(const [name,source]of Object.entries(files))file(name,source)
symlinkSync(join(project,'packages/linked'),join(project,'node_modules/linked'),'dir')
const {createServer}=await import(pathToFileURL(join(modules,'vite/dist/node/index.js')))
let server,ssrServer
try{
  server=await createServer({root:project,configFile:false,logLevel:'silent',server:{middlewareMode:true,watch:null},optimizeDeps:{noDiscovery:true,include:[]}})
  // Vite creates environment plugins lazily; a normal resolution realizes them.
  await server.environments.client.pluginContainer.resolveId('./relative.js',join(project,'src/main.js'))
  const chosen=captured.find(item=>item.descriptor.options.environmentName==='client')
  assert.ok(chosen,'Vite must instantiate a client builtin resolver')
  assert.deepEqual(shape(descriptor(project,resolveSubpathImports,()=>{})),shape(chosen.descriptor))
  const fixtureTrace=[]
  const fixturePlugin=new Native(descriptor(project,(...args)=>{const value=resolveSubpathImports(...args);fixtureTrace.push({name:'resolveSubpathImports',args,value});return value},()=>{}))
  trace.length=0
  const results=[]
  for(const {name,specifier,expected}of cases){
    const result=await chosen.plugin.resolveId(specifier,join(project,'src/main.js'),{isEntry:false})
    assert.equal(result.id,join(project,expected),name)
    assert.deepEqual(await fixturePlugin.resolveId(specifier,join(project,'src/main.js'),{isEntry:false}),result,'Owned callback parity: '+name)
    results.push({name,specifier,result})
  }
  assert.ok(trace.some(item=>item.name==='resolveSubpathImports'&&item.args[0]==='#local'&&item.value==='./imported.js'))
  assert.deepEqual(fixtureTrace,trace.filter(item=>item.name==='resolveSubpathImports').map(({name,args,value})=>({name,args,value})))
  const hooks=[];for(const key in chosen.plugin)hooks.push(key)
  const clientTrace=[...trace]
  // Start's default server environment is named ssr, with consumer server.
  // Framework exclusions come from its config plan; this remains a resolver fixture.
  ssrServer=await createServer({root:project,configFile:false,logLevel:'silent',server:{middlewareMode:true,watch:null},resolve:{noExternal:['@tanstack/start**','@tanstack/react-start**']},environments:{ssr:{consumer:'server',optimizeDeps:{noDiscovery:true,include:[]}}},optimizeDeps:{noDiscovery:true,include:[]}})
  await ssrServer.environments.ssr.pluginContainer.resolveId('./relative.js',join(project,'src/main.js'))
  const serverChosen=captured.findLast(item=>item.descriptor.options.environmentName==='ssr')
  assert.ok(serverChosen,'Vite must instantiate an SSR builtin resolver')
  const serverFixtureTrace=[]
  const serverFixture=new Native({...serverChosen.descriptor,options:{...serverChosen.descriptor.options,resolveSubpathImports(...args){const value=resolveSubpathImports(...args);serverFixtureTrace.push({name:'resolveSubpathImports',args,value});return value}}})
  trace.length=0
  const serverResults=[]
  for(const {name,specifier,expected}of [...cases,{name:'node builtin',specifier:'node:fs'},{name:'bare builtin',specifier:'fs'}]){
    const result=await serverChosen.plugin.resolveId(specifier,join(project,'src/main.js'),{isEntry:false})
    if(expected)assert.equal(result.id,join(project,expected),'SSR '+name)
    else assert.deepEqual(result,{id:specifier,external:true,moduleSideEffects:false},'SSR builtin externalization')
    assert.deepEqual(await serverFixture.resolveId(specifier,join(project,'src/main.js'),{isEntry:false}),result,'SSR owned callback parity: '+name)
    serverResults.push({name,specifier,result})
  }
  const serverHooks=[];for(const key in serverChosen.plugin)serverHooks.push(key)
  assert.deepEqual(serverFixtureTrace,trace.filter(item=>item.name==='resolveSubpathImports').map(({name,args,value})=>({name,args,value})))
  const serverEvidence={descriptor:shape(serverChosen.descriptor),hooks:serverHooks,order:serverChosen.plugin.getOrder('resolveId'),trace:[...trace],fixtureTrace:serverFixtureTrace,results:serverResults}
  // The captured watch:null descriptor disables caching. Enable only that cache
  // for this native invalidation experiment, keeping the actual Vite callback.
  const cachedDescriptor={...serverChosen.descriptor,options:{...serverChosen.descriptor.options,disableCache:false}}
  const cached=new Native(cachedDescriptor)
  const cachedFixture=new Native({...cachedDescriptor,options:{...cachedDescriptor.options,resolveSubpathImports}})
  async function resolveUpdate(){
    const args=[updateCase.specifier,join(project,'src/main.js'),{isEntry:false}]
    const result=await cached.resolveId(...args)
    assert.deepEqual(await cachedFixture.resolveId(...args),result,'Cache fixture callback parity')
    return result
  }
  const before=await resolveUpdate()
  assert.equal(before.id,join(project,updateCase.before))
  file(updateCase.path,updateCase.source)
  const afterWrite=await resolveUpdate()
  const watchResult=await cached.watchChange(join(project,updateCase.path),updateCase.event)
  await cachedFixture.watchChange(join(project,updateCase.path),updateCase.event)
  const afterWatch=await resolveUpdate()
  const update={descriptor:shape(cachedDescriptor),case:updateCase,before,afterWrite,watchResult:watchResult??null,afterWatch,changed:afterWatch.id===join(project,updateCase.after)}
  await serverChosen.plugin.watchChange(join(project,updateCase.path),updateCase.event)
  await serverFixture.watchChange(join(project,updateCase.path),updateCase.event)
  const uncachedAfter=await serverChosen.plugin.resolveId(updateCase.specifier,join(project,'src/main.js'),{isEntry:false})
  assert.deepEqual(await serverFixture.resolveId(updateCase.specifier,join(project,'src/main.js'),{isEntry:false}),uncachedAfter)
  const uncachedUpdate={case:updateCase,before:serverResults.find(item=>item.name==='exports').result,afterWatch:uncachedAfter,changed:uncachedAfter.id===join(project,updateCase.after),disableCache:true}
  await chosen.plugin.watchChange(join(project,updateCase.path),updateCase.event)
  await fixturePlugin.watchChange(join(project,updateCase.path),updateCase.event)
  const clientAfter=await chosen.plugin.resolveId(updateCase.specifier,join(project,'src/main.js'),{isEntry:false})
  assert.deepEqual(await fixturePlugin.resolveId(updateCase.specifier,join(project,'src/main.js'),{isEntry:false}),clientAfter)
  assert.equal(clientAfter.id,join(project,updateCase.after))
  assert.equal(uncachedAfter.id,join(project,updateCase.after))
  const updates={client:{before:results.find(item=>item.name==='exports').result,after:clientAfter},server:{before:uncachedUpdate.before,after:uncachedAfter}}
  console.log(JSON.stringify({versions:{vite:'8.3.0',rolldown:'1.2.9'},project,descriptor:shape(chosen.descriptor),hooks,order:chosen.plugin.getOrder('resolveId'),trace:clientTrace,fixtureTrace,results,server:serverEvidence,update,uncachedUpdate,updates},null,2))
}finally{await ssrServer?.close();await server?.close();binding.BindingCallableBuiltinPlugin=Native}
