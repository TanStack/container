import {contextGlobalCases} from './context-global-cases.mjs'

export const vmContextCases = [
  ...contextGlobalCases.map(fixture=>({name:'live global | '+fixture.name,code:`
    globalThis.sandbox=${fixture.setup};
    vm.createContext(sandbox,{codeGeneration:{strings:${fixture.strings!==false},wasm:false}});
    globalThis.runInChild=(source,timeout)=>vm.runInContext(source,sandbox,{timeout});
    const rows=[];
    for(const [realm,source] of ${JSON.stringify(fixture.steps)}){
      try{const value=realm==='child'?vm.runInContext(source,sandbox):(0,eval)(source);rows.push(value===undefined?{undefined:true}:{value})}
      catch(error){rows.push({error:error.name})}
    }
    console.log(JSON.stringify(rows));
  `})),
  {name:'context identity and one script in multiple contexts',code:`
    const a={value:1},b={value:10};
    const seen=[vm.isContext(a),vm.createContext(a)===a,vm.isContext(a),vm.createContext(a)===a];
    vm.createContext(b);
    const script=new vm.Script('value+=1;value');
    seen.push(script.runInContext(a),script.runInContext(b),script.runInContext(a),a.value,b.value);
    seen.push(vm.runInNewContext('value*2',{value:21}),new vm.Script('value*3').runInNewContext({value:14}));
    console.log(JSON.stringify(seen));
  `},
  {name:'new-context code-generation options',code:`
    const seen=[];
    for(const run of [()=>vm.runInNewContext('eval("42")',{}, {contextCodeGeneration:{strings:false}}),
      ()=>new vm.Script('Function("return 42")()').runInNewContext({}, {contextCodeGeneration:{strings:false}})]){
      try{seen.push(run())}catch(e){seen.push(e.name)}
    }
    console.log(JSON.stringify(seen));
  `},
  {name:'raw values, native async functions and overlapping ALS',code:`
    const als=new AsyncLocalStorage(),sandbox={als,rootArray:Array,rootPromise:Promise};vm.createContext(sandbox);
    const task=vm.runInContext('(async function(gate){const before=als.getStore();await gate;await 0;return [before,als.getStore()]})',sandbox);
    let release;const gate=new Promise(r=>release=r);
    const a=als.run('a',()=>task(gate)),b=als.run('b',()=>task(gate));
    als.run('resolver',release);
    console.log(JSON.stringify([await Promise.all([a,b]),vm.runInContext('[]',sandbox) instanceof Array,vm.runInContext('Promise.resolve(42)',sandbox) instanceof Promise,await vm.runInContext('Promise.resolve(42)',sandbox)]));
  `},
  {name:'generated imports cannot use the workspace module loader',kind:'policy',expected:JSON.stringify(Array(4).fill('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING'))+'\n',code:`
    const sandbox=vm.createContext({}),seen=[];
    for(const make of [()=>vm.runInContext('()=>import("node:fs")',sandbox),
      ()=>vm.runInContext('Function',sandbox)('return import("node:fs")'),
      ()=>vm.runInContext('eval',sandbox)('()=>import("node:fs")'),
      ()=>vm.runInContext('(async()=>{}).constructor',sandbox)('return import("node:fs")')]){
      const fn=make();
      try{await fn();seen.push('imported')}catch(e){seen.push(e.code)}
    }
    console.log(JSON.stringify(seen));
  `},
  {name:'child realms cannot see kernel capabilities or initialization hooks',code:`
    const sandbox=vm.createContext({});
    console.log(JSON.stringify(vm.runInContext('[typeof process,typeof require,typeof fetch,typeof document,typeof __webContainerHost,typeof __qjsCompileScript,typeof __qjsCreateContext,typeof __qjsContextifyGlobal,typeof __qjsExecutePendingJobs,typeof __qjsGetAsyncContext,typeof __qjsSetAsyncContext]',sandbox)));
  `},
]
