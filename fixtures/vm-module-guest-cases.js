(async()=>{
  const check=(value,message)=>{if(!value)throw Error(message)}
  const synthetic=new SyntheticModule(['value'],function(){this.setExport('value',17)})
  const root=new SourceTextModule("import {value} from 'dep';export {value};export const answer=import.meta.answer",{initializeImportMeta(meta){meta.answer=42}})
  const broken=new SourceTextModule("import 'missing'")
  const failure=new Error('missing')
  try{await broken.link(()=>{throw failure})}catch(error){check(error===failure,'link error identity')}
  check(broken.status==='linking','failed linker status')
  for(const key of ['namespace','error'])try{broken[key];check(false,'failed linker getter accepted')}catch(error){check(error.code==='ERR_VM_MODULE_STATUS','failed linker getter code')}
  const asyncBroken=new SourceTextModule("import 'missing'")
  try{await asyncBroken.link(async()=>{throw failure})}catch(error){check(error===failure,'async link identity')}
  check(asyncBroken.status==='errored'&&asyncBroken.error===failure,'async link status')
  try{asyncBroken.namespace;check(false,'async link namespace accepted')}catch(error){check(error.code==='ERR_VM_MODULE_STATUS','async link namespace code')}
  asyncBroken.dispose()
  await root.link(async()=>synthetic)
  check(root.status==='linked','linked status')
  await root.evaluate()
  check(root.namespace.value===17,'initial export')
  synthetic.setExport('value',24)
  check(root.namespace.value===24&&root.namespace.answer===42,'live export and import meta')
  const dynamic=new SourceTextModule("export const load=()=>import('dep')",{importModuleDynamically(name,referrer){check(name==='dep'&&referrer===dynamic,'dynamic callback arguments');return synthetic}})
  await dynamic.link(()=>{});await dynamic.evaluate()
  check((await dynamic.namespace.load()).value===24,'dynamic namespace')
  const namespaceReturn=new SourceTextModule("export const load=()=>import('dep')",{importModuleDynamically:()=>synthetic.namespace})
  await namespaceReturn.link(()=>{});await namespaceReturn.evaluate()
  const importedNamespace=await namespaceReturn.namespace.load()
  check(importedNamespace===synthetic.namespace,'returned namespace identity')
  synthetic.setExport('value',25);check(importedNamespace.value===25,'returned namespace live export');synthetic.setExport('value',24)
  namespaceReturn.dispose()
  const temporary=new SyntheticModule(['value'],function(){this.setExport('value',1)})
  await temporary.link(()=>{});await temporary.evaluate();const staleNamespace=temporary.namespace;temporary.dispose()
  const staleReturn=new SourceTextModule("export const load=()=>import('dep')",{importModuleDynamically:()=>staleNamespace})
  await staleReturn.link(()=>{});await staleReturn.evaluate()
  try{await staleReturn.namespace.load();check(false,'disposed namespace accepted')}catch(error){check(error.code==='ERR_VM_MODULE_STATUS','disposed namespace code')}
  staleReturn.dispose()
  const sentinel={message:'callback rejection'}
  const rejectedImport=new SourceTextModule("export const load=()=>import('dep')",{importModuleDynamically(){throw sentinel}})
  await rejectedImport.link(()=>{});await rejectedImport.evaluate()
  try{await rejectedImport.namespace.load();check(false,'expected rejection')}catch(error){check(error===sentinel,'dynamic rejection identity')}
  const self=new SourceTextModule("export const value=5;export const load=()=>import('self')",{importModuleDynamically(){return self}})
  await self.link(()=>{});await self.evaluate();check((await self.namespace.load()).value===5,'dynamic self cycle')
  const missingHook=new SourceTextModule("export const load=()=>import('missing')")
  await missingHook.link(()=>{});await missingHook.evaluate()
  try{await missingHook.namespace.load();check(false,'missing hook accepted')}catch(error){check(error.code==='ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING','missing hook code')}
  const invalidReturn=new SourceTextModule("export const load=()=>import('invalid')",{importModuleDynamically:()=>({})})
  await invalidReturn.link(()=>{});await invalidReturn.evaluate()
  try{await invalidReturn.namespace.load();check(false,'invalid return accepted')}catch(error){check(error.code==='ERR_VM_MODULE_NOT_MODULE','invalid module code')}
  let release
  const delayed=new SourceTextModule("export const load=()=>import('delayed')",{importModuleDynamically:()=>new Promise(resolve=>{release=resolve})})
  await delayed.link(()=>{});await delayed.evaluate()
  const pending=delayed.namespace.load();await Promise.resolve();delayed.dispose();release(synthetic)
  try{await pending;check(false,'disposed import accepted')}catch(error){check(error.message==='Importing module is disposed','disposed pending import')}
  const releases=[]
  const bounded=new SourceTextModule("export const load=()=>import('bounded')",{importModuleDynamically:()=>new Promise(resolve=>releases.push(resolve))})
  await bounded.link(()=>{});await bounded.evaluate()
  const queued=Array.from({length:32},()=>bounded.namespace.load())
  try{await bounded.namespace.load();check(false,'pending limit accepted')}catch(error){check(error instanceof RangeError,'pending bound')}
  for(const resolve of releases)resolve(synthetic)
  await Promise.all(queued)
  for(const m of [missingHook,invalidReturn,bounded])m.dispose()
  if(typeof __qjsCompileScript==='function'){
    const callback=async()=>synthetic.namespace
    const first=__qjsCompileScript("()=>import('dep')",'same.js',0,0,callback)()
    const second=__qjsCompileScript("import('dep')",'same.js',0,0,()=>Promise.reject(sentinel))
    check((await first()).value===24,'retained script callback')
    try{await second();check(false,'expected script rejection')}catch(error){check(error===sentinel,'independent script callback')}
  }
  for(const m of [dynamic,rejectedImport,self])m.dispose()
  const a=new SourceTextModule("import {b} from 'b';export function a(){return b()};export const value=7")
  const b=new SourceTextModule("import {value} from 'a';export function b(){return value}")
  await a.link(async name=>name==='a'?a:b);await a.evaluate()
  check(a.namespace.a()===7,'cycle')
  const bad=new SourceTextModule("export const before=19;throw new Error('evaluation failure')")
  await bad.link(()=>{});try{await bad.evaluate()}catch(error){check(error===bad.error,'evaluation error identity')}
  check(bad.namespace.before===19,'errored module namespace')
  const handle=vmNative.create('export const value=1',undefined)
  vmNative.dispose(handle)
  let rejected=false;try{vmNative.requests(handle)}catch{rejected=true}check(rejected,'disposed handle')
  for(const m of [root,synthetic,broken,a,b,bad])m.dispose()
  const handles=[]
  for(let i=0;i<32;i++)handles.push(vmNative.create('export const value=1',undefined))
  let limited=false;try{vmNative.create('',undefined)}catch(error){limited=error instanceof RangeError}
  check(limited,'live handle limit')
  for(const h of handles)vmNative.dispose(h)
  for(let i=0;i<3;i++){
    for(let j=0;j<24;j++)vmNative.create('',undefined)
    await Promise.resolve() // Native harness runs GC between jobs.
  }
  const fresh=vmNative.create('',undefined);vmNative.dispose(fresh)
  if(typeof __qjsCreateContext==='function'&&typeof vmNative.status==='function'){
    const compiler=__qjsCreateContext({marker:99},true)
    if(compiler.vmModules){
      const ownedContext=typeof guestVM==='undefined'?compiler:guestVM.createContext({marker:99})
      const contextual=new SourceTextModule('export const value=globalThis.marker',{context:ownedContext})
      await contextual.link(()=>{});await contextual.evaluate()
      check(contextual.namespace.value===99,'context-owned module')
      contextual.dispose()
    }
  }
  return JSON.stringify({independentGraphRecovery:true,liveExport:24,cycle:7,importMeta:42,disposed:true,limitRecovery:true,gcRecovery:true,dynamicImports:true,pendingImportLimit:true})
})()
