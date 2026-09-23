// Each case runs in fresh parent/child realms, sharing only the sandbox object.
// 'parent' steps mutate the actual sandbox, never a JSON copy of it.
export const contextGlobalCases = [
  {name:'live external writes and callbacks',setup:'({x:1})',steps:[
    ['child','function read(){return x};read()'],
    ['parent','sandbox.x=42;sandbox.read()'],
    ['child','x=43;read()'],['parent','sandbox.x'],
  ]},
  {name:'declarations and outside deletion',setup:'({})',steps:[
    ['child','var x;Object.getOwnPropertyDescriptor(globalThis,"x")'],
    ['parent','Object.hasOwn(sandbox,"x")'],
    ['child','x=1;Object.getOwnPropertyDescriptor(globalThis,"x")'],
    ['parent','sandbox.x=2;delete sandbox.x'],
    ['child','x'],['child','x=3'],['parent','delete sandbox.x'],['child','x'],
  ]},
  {name:'declaration deletion retains hidden binding',setup:'({})',steps:[
    ['child','var x=1;delete x'],['parent','Object.hasOwn(sandbox,"x")'],
    ['child','[x,Object.getOwnPropertyDescriptor(globalThis,"x")]'],
    ['child','x=4;delete globalThis.x'],['child','x'],
  ]},
  {name:'lexical scope stays off the sandbox',setup:'({x:1})',steps:[
    ['child','let x=3;const y=4;[x,y,globalThis.x]'],
    ['parent','[sandbox.x,Object.hasOwn(sandbox,"y")]'],
    ['child','x+=2;[x,y,globalThis.x]'],['child','let x=9'],['child','x'],
  ]},
  {name:'unresolved closure becomes a lexical binding',setup:'({})',steps:[
    ['child','function read(){return later};typeof later'],
    ['child','let later=42;read()'],['parent','sandbox.read()'],
  ]},
  {name:'accessor receiver and outside replacement',setup:'(()=>{const s={};Object.defineProperty(s,"x",{get(){return this===s?7:-1},set(v){this.written=v},enumerable:true,configurable:true});return s})()',steps:[
    ['child','[x,globalThis.x]'],['child','x=12'],['parent','sandbox.written'],
    ['parent','Object.defineProperty(sandbox,"x",{value:42});sandbox.x'],['child','x'],
  ]},
  {name:'read-only sandbox descriptors',setup:'Object.defineProperty({},"x",{value:1,enumerable:true})',steps:[
    ['child','x=3;x'],['child','"use strict";x=3'],
    ['child','Object.getOwnPropertyDescriptor(globalThis,"x")'],['parent','sandbox.x'],
    ['child','delete x'],['child','let x=1'],
  ]},
  {name:'frozen sandbox has independent new globals',setup:'Object.freeze({x:1})',steps:[
    ['child','x=3;x'],['child','extra=4;extra'],
    ['parent','[sandbox.x,Object.hasOwn(sandbox,"extra")]'],
    ['child','var declared=5;declared'],['parent','Object.hasOwn(sandbox,"declared")'],
  ]},
  {name:'inherited sandbox values and setters',setup:'(()=>{const p={x:9,set y(v){this.written=v}};return Object.create(p)})()',steps:[
    ['child','[x,Object.hasOwn(globalThis,"x")]'],['child','x=3;y=12;x'],
    ['parent','[sandbox.x,sandbox.written,Object.hasOwn(sandbox,"x")]'],
  ]},
  {name:'missing values and strict assignments',setup:'({})',steps:[
    ['child','typeof missing'],['child','missing'],['child','"use strict";missing=42'],
    ['child','missing=3;missing'],['parent','sandbox.missing'],
    ['child','delete missing'],['child','typeof missing'],
  ]},
  {name:'explicit descriptors are live',setup:'({})',steps:[
    ['child','Object.defineProperty(globalThis,"x",{value:42});Object.getOwnPropertyDescriptor(globalThis,"x")'],
    ['parent','Object.getOwnPropertyDescriptor(sandbox,"x")'],['child','delete x'],
    ['child','Object.defineProperty(globalThis,"x",{value:5})'],
  ]},
  {name:'realm identities and sandbox self reference',setup:'(()=>{const s={parentArray:Array,parentPromise:Promise};s.self=s;return s})()',steps:[
    ['child','[Array===parentArray,Promise===parentPromise,[] instanceof parentArray,Promise.resolve(1) instanceof parentPromise]'],
    ['child','[globalThis===this,self===this,self===globalThis]'],
    ['parent','sandbox.self===sandbox'],
  ]},
  {name:'intrinsics can be shadowed without copying',setup:'({})',steps:[
    ['parent','typeof sandbox.Array'],['child','typeof Array'],
    ['parent','sandbox.Array=42'],['child','Array'],['parent','delete sandbox.Array'],
    ['child','typeof Array'],
  ]},
  {name:'global cannot be frozen',setup:'({})',steps:[
    ['child','Object.isExtensible(globalThis)'],['child','Reflect.preventExtensions(globalThis)'],
    ['child','Object.preventExtensions(globalThis)'],['child','Object.isExtensible(globalThis)'],
  ]},
  {name:'symbols and own keys',setup:'(()=>{const s={x:1};s[Symbol.for("probe")]=2;return s})()',steps:[
    ['child','[globalThis[Symbol.for("probe")],Object.getOwnPropertySymbols(globalThis).map(x=>Symbol.keyFor(x))]'],
    ['child','globalThis[Symbol.for("probe")]=42'],['parent','sandbox[Symbol.for("probe")]'],
    ['child','Object.keys(globalThis)'],
  ]},
  {name:'intrinsic constants are read-only',setup:'({})',steps:[
    ['child','undefined=42;typeof undefined'],['child','NaN=42;Number.isNaN(NaN)'],
    ['child','Infinity=42;Infinity===1/0'],['parent','Object.keys(sandbox)'],
  ]},
  {name:'function declarations replace configurable accessors',setup:'Object.defineProperty({},"f",{get(){return 1},configurable:true})',steps:[
    ['child','function f(){return 42};typeof f'],['child','f()'],
    ['parent','[typeof sandbox.f,sandbox.f()]'],
  ]},
  {name:'callbacks see edits made in the middle of a script',setup:'(()=>{const s={x:1};s.change=()=>{s.x=42};return s})()',steps:[
    ['child','const before=x;change();[before,x]'],
  ]},
  {name:'explicit definition conflicts with later lexical declarations',setup:'({})',steps:[
    ['child','Object.defineProperty(globalThis,"x",{value:1});0'],['child','let x=3;x'],
  ]},
  {name:'declared binding conflicts with later lexical declaration',setup:'({})',steps:[
    ['child','var x=1'],['child','let x=3;x'],
  ]},
  {name:'function declarations preserve live outside edits',setup:'({})',steps:[
    ['child','function f(){return 1};f()'],['parent','sandbox.f=()=>42;0'],
    ['child','f()'],['child','function f(){return 3};f()'],['parent','sandbox.f()'],
  ]},
  {name:'var declaration preserves existing sandbox values',setup:'({x:42})',steps:[
    ['child','var x;x'],['parent','sandbox.x'],['parent','delete sandbox.x'],['child','x'],
  ]},
  {name:'declared function name is not replaced by an accessor',setup:'Object.defineProperty({},"f",{get(){return 1}})',steps:[
    ['child','function f(){return 42};typeof f'],['child','typeof f'],
  ]},
  {name:'strict hoisting over a configurable getter',setup:'Object.defineProperty({},"f",{get(){return 1},configurable:true})',steps:[
    ['child','"use strict";function f(){return 42};typeof f'],
    ['parent','typeof sandbox.f'],
  ]},
  {name:'strict declarations and globalThis assignment',setup:'({})',steps:[
    ['child','"use strict";var x=42;function f(){return x};f()'],['parent','sandbox.f()'],
    ['child','"use strict";globalThis.y=12;y'],['parent','sandbox.y'],
  ]},
  {name:'direct eval keeps local and global environments separate',setup:'({x:1})',steps:[
    ['child','(()=>{let x=3;return eval("x+=2")})()'],['child','x'],
    ['child','eval("var y=4");y'],['parent','sandbox.y'],['child','delete y'],
  ]},
  {name:'indirect eval stays inside its realm',setup:'({})',steps:[
    ['child','(0,eval)("var y=4");y'],['parent','sandbox.y'],['child','delete y'],
    ['child','typeof y'],
  ]},
  {name:'outside deletion of explicit definitions',setup:'({})',steps:[
    ['child','Object.defineProperty(globalThis,"x",{value:42,writable:true,configurable:true});0'],
    ['parent','delete sandbox.x'],['child','[typeof x,x]'],
  ]},
  {name:'global accessor definitions preserve the receiver',setup:'(()=>{const s={};s.self=s;return s})()',steps:[
    ['child','Object.defineProperty(globalThis,"x",{get(){return this===self?42:-1},configurable:true});x'],
    ['parent','sandbox.x'],
  ]},
  {name:'prototype changes remain live',setup:'({x:1})',steps:[
    ['parent','Object.setPrototypeOf(sandbox,{inherited:42});0'],['child','inherited'],
    ['child','Object.getPrototypeOf(globalThis)===Object.prototype'],
    ['child','Object.setPrototypeOf(globalThis,{childProto:7});childProto'],
    ['parent','typeof sandbox.childProto'],
  ]},
  {name:'globalThis receiver can be overwritten and restored',setup:'({})',steps:[
    ['child','var original=this;globalThis=42;globalThis'],['parent','sandbox.globalThis'],
    ['child','globalThis=original;globalThis===this'],
  ]},
  {name:'outside lexical shadow does not mutate lexical binding',setup:'({})',steps:[
    ['child','let x=42'],['parent','sandbox.x=12'],['child','[x,globalThis.x]'],
    ['child','globalThis.x=13;[x,globalThis.x]'],['parent','sandbox.x'],
  ]},
  {name:'Reflect.get keeps sandbox accessor receivers',setup:'({x:1,get tag(){return this.x}})',steps:[
    ['child','Reflect.get(globalThis,"tag",{x:42})'],
    ['child','Object.setPrototypeOf(globalThis,{get y(){return this.x}});y'],
  ]},
  {name:'Reflect.set writes to the supplied receiver',setup:'({x:1})',steps:[
    ['child','var receiver={x:3};Reflect.set(globalThis,"x",42,receiver);[x,receiver.x]'],
    ['parent','sandbox.x'],
  ]},
  {name:'Reflect.set handles context accessors and readonly data',setup:'(()=>{const s={get x(){return this.y},set x(v){this.y=v}};Object.defineProperty(s,"fixed",{value:1});return s})()',steps:[
    ['child','var receiver={y:3};Reflect.set(globalThis,"x",42,receiver);[receiver.y,receiver.x,typeof y]'],
    ['child','[Reflect.set(globalThis,"fixed",42,receiver),receiver.fixed,fixed]'],
    ['child','Reflect.set(globalThis,"other",42,Object.freeze({}))'],
  ]},
  {name:'global prototype setters see the live sandbox',setup:'({})',steps:[
    ['child','Object.setPrototypeOf(globalThis,{set z(v){this.written=v}});z=4;written'],
    ['parent','[sandbox.z,sandbox.written]'],
  ]},
  {name:'global prototype cycles are rejected',setup:'({})',steps:[
    ['child','Reflect.setPrototypeOf(globalThis,globalThis)'],
    ['child','Object.setPrototypeOf(globalThis,Object.create(globalThis))'],
    ['child','Object.getPrototypeOf(globalThis)===globalThis'],
  ]},
  {name:'global prototype has its own anonymous constructor',setup:'({})',steps:[
    ['child','var C=Object.getPrototypeOf(globalThis).constructor;[C.name,C.length,Object.getPrototypeOf(C)===Function.prototype,C===Object]'],
    ['child','Object.getOwnPropertyNames(Object.getPrototypeOf(globalThis))'],
    ['child','[Object.getPrototypeOf(new C())===Object.getPrototypeOf(globalThis),C() instanceof C]'],
    ['child','class D extends C{};new D() instanceof D'],
  ]},
  {name:'contextified globals retain code-generation restrictions',setup:'({})',strings:false,steps:[
    ['child','eval("42")'],['child','Function("return 42")()'],
    ['child','(async()=>{}).constructor("return 42")'],
    ['parent','runInChild("let answer=42;answer")'],['child','answer'],
  ]},
  {name:'compiled scripts retain bridge deadlines and recover',setup:'({})',steps:[
    ['parent','try{runInChild("while(true){}",10)}catch(e){e.code}'],
    ['parent','runInChild("var answer=42;answer")'],['parent','sandbox.answer'],
    ['child','answer'],
  ]},
  {name:'timeouts cross the bridge into sandbox callbacks',setup:'({spin(){const end=Date.now()+100;while(Date.now()<end){};return "escaped"}})',steps:[
    ['parent','try{runInChild("spin()",10)}catch(e){e.code}'],
    ['child','40+2'],
  ]},
  {name:'large global key enumeration retains order and values',setup:'Object.fromEntries(Array.from({length:2000},(_,i)=>["k"+i,i]))',steps:[
    ['child','var names=Object.keys(globalThis);[names.length,names[0],names[1999],names.filter(k=>k!=="names").reduce((sum,key)=>sum+globalThis[key],0)]'],
  ]},
]

export function probeContextGlobals(engine,reference){
  const rows=[]
  for(const fixture of contextGlobalCases){
    const runtime=engine.newRuntime(),parent=runtime.newContext(),child=runtime.newContext()
    const handles=[]
    const evaluate=(ctx,source)=>{const handle=ctx.unwrapResult(ctx.evalCode(source));handles.push(handle);return handle}
    runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024)
    const deadline=Date.now()+3000;runtime.setInterruptHandler(()=>Date.now()>deadline)
    try{
      const sandbox=evaluate(parent,`globalThis.sandbox=${fixture.setup};sandbox`)
      const configure=evaluate(child,'__qjsContextifyGlobal')
      const compile=evaluate(child,'__qjsCompileScript')
      parent.setProp(parent.global,'__compile',compile)
      evaluate(parent,'globalThis.runInChild=(compile=>(source,timeout)=>compile(source,"context.js",0,0)(timeout))(__compile);delete globalThis.__compile')
      if(fixture.strings===false)evaluate(child,'__qjsDisableStringCodeGeneration()')
      evaluate(child,'delete globalThis.__qjsContextifyGlobal;delete globalThis.__qjsCompileScript;delete globalThis.__qjsDisableStringCodeGeneration;delete globalThis.__qjsGetAsyncContext;delete globalThis.__qjsSetAsyncContext;delete globalThis.__qjsCreateContext;delete globalThis.__qjsExecutePendingJobs')
      const global=child.unwrapResult(child.callFunction(configure,child.undefined,sandbox));handles.push(global)
      const actual=[]
      for(const [realm,source] of fixture.steps){
        const ctx=realm==='parent'?parent:child,result=ctx.evalCode(source)
        try{
          if(result.error){const error=ctx.dump(result.error);actual.push({error:error.name})}
          else {const value=ctx.dump(result.value);actual.push(value===undefined?{undefined:true}:{value})}
        }finally{result.dispose()}
      }
      const expected=reference[fixture.name]
      rows.push({name:fixture.name,steps:fixture.steps,actual,expected,matches:JSON.stringify(actual)===JSON.stringify(expected)})
    }finally{
      handles.reverse().forEach(handle=>handle.dispose());child.dispose();parent.dispose();runtime.dispose()
    }
  }
  return rows
}
