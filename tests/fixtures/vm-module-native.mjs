import vm from 'node:vm'
import assert from 'node:assert/strict'

// Native oracle only. This does not claim the guest bridge implements VM modules.
const context=vm.createContext({marker:42})
const synthetic=new vm.SyntheticModule(['value'],function(){this.setExport('value',17)},{context,identifier:'synthetic'})
const source=new vm.SourceTextModule(`
  import {value} from 'synthetic';
  export function read(){return value}
  export const marker=globalThis.marker;
  export const meta=import.meta.answer;
`,{context,identifier:'source',initializeImportMeta(meta){meta.answer=23}})
await source.link(async specifier=>{assert.equal(specifier,'synthetic');return synthetic})
assert.equal(source.status,'linked')
await source.evaluate()
assert.equal(source.namespace.read(),17)
synthetic.setExport('value',24)
assert.equal(source.namespace.read(),24)
assert.equal(source.namespace.marker,42)
assert.equal(source.namespace.meta,23)

// Linking one graph must not invalidate an unrelated, still-unlinked graph.
const dependency=new vm.SourceTextModule('export const value=31',{context,identifier:'dependency'})
const survivor=new vm.SourceTextModule("import {value} from 'dependency';export {value}",{context,identifier:'survivor'})
const broken=new vm.SourceTextModule("import 'missing'",{context,identifier:'broken'})
const failure=new Error('missing dependency')
await assert.rejects(broken.link(async()=>{throw failure}),error=>error===failure)
assert.equal(broken.status,'errored')
assert.throws(()=>broken.namespace,{code:'ERR_VM_MODULE_STATUS'})
assert.equal(broken.error,failure)
const synchronousBroken=new vm.SourceTextModule("import 'missing'")
await assert.rejects(synchronousBroken.link(()=>{throw failure}),error=>error===failure)
assert.equal(synchronousBroken.status,'linking')
assert.throws(()=>synchronousBroken.error,{code:'ERR_VM_MODULE_STATUS'})
assert.equal(survivor.status,'unlinked')
await survivor.link(async()=>dependency)
await survivor.evaluate()
assert.equal(survivor.namespace.value,31)

const a=new vm.SourceTextModule("import {b} from 'b';export function a(){return b()};export const value=7",{context,identifier:'a'})
const b=new vm.SourceTextModule("import {value} from 'a';export function b(){return value}",{context,identifier:'b'})
await a.link(async specifier=>specifier==='a'?a:b)
await a.evaluate()
assert.equal(a.namespace.a(),7)

const dynamic=new vm.SourceTextModule("export const result=(await import('dep')).value",{
  context,identifier:'dynamic',importModuleDynamically:async()=>dependency,
})
await dynamic.link(()=>{throw Error('unexpected static dependency')})
await dynamic.evaluate()
assert.equal(dynamic.namespace.result,31)
const script=new vm.Script("()=>import('dep')",{filename:'same.js',importModuleDynamically:()=>dependency})
const retained=script.runInContext(context)
const rejectedScript=new vm.Script("import('dep')",{filename:'same.js',importModuleDynamically:()=>{throw failure}})
assert.equal((await retained()).value,31)
const namespaceScript=new vm.Script("import('dep')",{importModuleDynamically:()=>synthetic.namespace})
assert.equal(await namespaceScript.runInContext(context),synthetic.namespace)
await assert.rejects(rejectedScript.runInContext(context),error=>error===failure)
const unlinked=new vm.SourceTextModule('export const value=1',{context})
await assert.rejects(new vm.Script("import('unlinked')",{importModuleDynamically:()=>unlinked}).runInContext(context),{code:'ERR_VM_MODULE_STATUS'})
const linkedOnly=new vm.SourceTextModule('export const value=1',{context});await linkedOnly.link(()=>{})
const linkedNamespace=await new vm.Script("import('linked')",{importModuleDynamically:()=>linkedOnly}).runInContext(context)
assert.equal(linkedOnly.status,'linked')
assert.throws(()=>linkedNamespace.value,{name:'ReferenceError'})

const thrown=new vm.SourceTextModule('export const before=19;throw globalThis.failure',{context,identifier:'thrown'})
context.failure=Object.assign(new Error('evaluation failure'),{code:'FIXTURE'})
await thrown.link(()=>{throw Error('unexpected dependency')})
await assert.rejects(thrown.evaluate(),error=>error===context.failure)
assert.equal(thrown.status,'errored')
assert.equal(thrown.error,context.failure)
assert.equal(thrown.namespace.before,19)
console.log(JSON.stringify({liveExport:source.namespace.read(),context:source.namespace.marker,importMeta:source.namespace.meta,recovered:survivor.namespace.value,cycle:a.namespace.a(),dynamic:dynamic.namespace.result,errorIdentity:thrown.error===context.failure}))
